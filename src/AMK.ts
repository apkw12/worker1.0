import { connect } from 'cloudflare:sockets'
import { GetAMKConfig, MuddleDomain, getUUID } from "./helpers"
import { cfPorts, proxiesUri } from "./variables"
import { RemoteSocketWrapper, CustomArrayBuffer, AMKHeader, UDPOutbound, Config, Env } from "./interfaces"

const WS_READY_STATE_OPEN: number = 1
const WS_READY_STATE_CLOSING: number = 2
let proxyIP: string = ""
let proxyList: Array<string> = []
let blockPorn: string = ""
let filterCountries: string = ""
let countries: Array<string> = []

export async function GetAMKConfigList(sni: string, addressList: Array<string>, start: number, max: number, env: Env) {
  filterCountries = ""
  blockPorn = ""
  proxyList = []
  const uuid = getUUID(sni)
  let configList: Array<Config> = []
  for (let i = 0; i < max; i++) {
    configList.push(GetAMKConfig(
      i + start,
      uuid,
      MuddleDomain(sni),
      addressList[Math.floor(Math.random() * addressList.length)],
      cfPorts[Math.floor(Math.random() * cfPorts.length)]
    ))
  }

  return configList
}

export async function AMKOverWSHandler(request: Request, sni: string, env: Env) {
  const uuid = getUUID(sni)
  const [client, webSocket]: Array<WebSocket> = Object.values(new WebSocketPair)
  webSocket.accept()

  let address: string = ""
  const earlyDataHeader: string = request.headers.get("sec-websocket-protocol") || ""
  const readableWebSocketStream = MakeReadableWebSocketStream(webSocket, earlyDataHeader)

  let remoteSocketWapper: RemoteSocketWrapper = {
    value: null,
  }
  let udpStreamWrite: CallableFunction | null = null
  let isDns = false

  readableWebSocketStream.pipeTo(new WritableStream({
    async write(chunk, controller) {
      if (isDns && udpStreamWrite) {
        return udpStreamWrite(chunk)
      }
      if (remoteSocketWapper.value) {
        const writer = remoteSocketWapper.value.writable.getWriter()
        await writer.write(chunk)
        writer.releaseLock()
        return
      }

      const {
        hasError,
        message,
        addressRemote = '',
        addressType,
        portRemote = 443,
        rawDataIndex,
        AMKVersion = new Uint8Array([0, 0]),
        isUDP,
        isMUX,
      } = ProcessAMKHeader(chunk, uuid)
      
      address = addressRemote
      
      if (hasError) {
        throw new Error(message)
      }

      if (isUDP) {
        if (portRemote === 53) {
          isDns = true
        } else {
          throw new Error('UDP proxy only enable for DNS which is port 53')
        }
      } else if (isMUX) {
        throw new Error('MUX is not supported!')
      }

      const AMKResponseHeader: Uint8Array = new Uint8Array([AMKVersion[0], 0])
      const rawClientData: Uint8Array = chunk.slice(rawDataIndex)

      if (isDns) {
        const { write }: UDPOutbound = await HandleUDPOutbound(webSocket, AMKResponseHeader, env)
        udpStreamWrite = write
        udpStreamWrite(rawClientData)
        return
      }

      HandleTCPOutbound(remoteSocketWapper, addressRemote, portRemote, rawClientData, webSocket, AMKResponseHeader, env)
    }
  })).catch((err) => { })

  return new Response(null,  {
    status: 101,
    webSocket: client,
  })
}

function MakeReadableWebSocketStream(webSocketServer: WebSocket, earlyDataHeader: string): ReadableStream {
  let readableStreamCancel: boolean = false
  const stream: ReadableStream = new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener('message', (event) => {
        if (readableStreamCancel) {
          return
        }
        const message: string | ArrayBuffer = event.data
        controller.enqueue(message)
      })

      webSocketServer.addEventListener('close', () => {
        SafeCloseWebSocket(webSocketServer)
        if (readableStreamCancel) {
          return
        }
        controller.close()
      })

      webSocketServer.addEventListener('error', (err) => {
        controller.error(err)
      })

      const {earlyData, error}: CustomArrayBuffer = Base64ToArrayBuffer(earlyDataHeader)
      
      if (error) {
        controller.error(error)
      } else if (earlyData) {
        controller.enqueue(earlyData)
      }
    },
    cancel(reason) {
      if (readableStreamCancel) {
        return
      }
      readableStreamCancel = true
      SafeCloseWebSocket(webSocketServer)
    }
  })

  return stream
}

function ProcessAMKHeader(AMKBuffer: ArrayBuffer, uuid: string): AMKHeader {
  if (AMKBuffer.byteLength < 24) {
    return {
      hasError: true,
      message: 'Invalid data',
    } as AMKHeader
  }

  const version: Uint8Array = new Uint8Array(AMKBuffer.slice(0, 1))
  let isValidUser: boolean = false
  let isUDP: boolean = false
  let isMUX: boolean = false
  
  if (Stringify(new Uint8Array(AMKBuffer.slice(1, 17))) === uuid) {
    isValidUser = true
  }

  if (!isValidUser) {
    return {
      hasError: true,
      message: 'Invalid user',
    } as AMKHeader
  }

  const optLength: number = new Uint8Array(AMKBuffer.slice(17, 18))[0]

  const command: number = new Uint8Array(
    AMKBuffer.slice(18 + optLength, 18 + optLength + 1)
  )[0]

  if (command === 1) {
  } else if (command === 2) {
    isUDP = true
  } else if (command === 3) {
    isMUX = true
  } else {
    return {
      hasError: true,
      message: `Command ${command} is not support, command 01-tcp, 02-udp, 03-mux`,
    } as AMKHeader
  }

  const portIndex: number = 18 + optLength + 1
  const portBuffer: ArrayBuffer = AMKBuffer.slice(portIndex, portIndex + 2)
  const portRemote: number = new DataView(portBuffer).getUint16(0)

  let addressIndex: number = portIndex + 2
  const addressBuffer: Uint8Array = new Uint8Array(
    AMKBuffer.slice(addressIndex, addressIndex + 1)
  )

  const addressType: number = addressBuffer[0]
  let addressLength: number = 0
  let addressValueIndex: number = addressIndex + 1
  let addressValue: string = ""
  
  switch (addressType) {
    case 1:
      addressLength = 4
      addressValue = new Uint8Array(
        AMKBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      ).join(".")
      break
    case 2:
      addressLength = new Uint8Array(
        AMKBuffer.slice(addressValueIndex, addressValueIndex + 1)
      )[0]
      addressValueIndex += 1
      addressValue = new TextDecoder().decode(
        AMKBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      )
      break
    case 3:
      addressLength = 16
      const dataView = new DataView(
        AMKBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      )
      const ipv6: Array<string> = []
      for (let i = 0; i < 8; i++) {
        ipv6.push(dataView.getUint16(i * 2).toString(16))
      }
      addressValue = ipv6.join(":")
      break
    default:
      return {
        hasError: true,
        message: `invild  addressType is ${addressType}`,
      } as AMKHeader
  }
  if (!addressValue) {
    return {
      hasError: true,
      message: `addressValue is empty, addressType is ${addressType}`,
    } as AMKHeader
  }

  return {
    hasError: false,
    addressRemote: addressValue,
    addressType: addressType,
    portRemote: portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    AMKVersion: version,
    isUDP: isUDP,
    isMUX: isMUX,
  } as AMKHeader
}

async function HandleUDPOutbound(webSocket: WebSocket, AMKResponseHeader: ArrayBuffer, env: Env): Promise<UDPOutbound> {
  let isAMKHeaderSent = false
  const transformStream = new TransformStream({
    transform(chunk, controller) {
      for (let index: number = 0; index < chunk.byteLength;) {
        const lengthBuffer = chunk.slice(index, index + 2)
        const udpPakcetLength = new DataView(lengthBuffer).getUint16(0)
        const udpData = new Uint8Array(
          chunk.slice(index + 2, index + 2 + udpPakcetLength)
        )
        index = index + 2 + udpPakcetLength
        controller.enqueue(udpData)
      }
    }
  })

  if (blockPorn == "") {
    blockPorn = await env.settings.get("BlockPorn") || 'no'
  }
  
  // only handle dns udp for now
  transformStream.readable.pipeTo(new WritableStream({
    async write(chunk: any) {
      const resp = await fetch(blockPorn == "yes" ? "https://1.1.1.3/dns-query": "https://1.1.1.1/dns-query", {
        method: 'POST',
        headers: {
          'content-type': 'application/dns-message',
        },
        body: chunk,
      })
      const dnsQueryResult: ArrayBuffer = await resp.arrayBuffer()
      const udpSize: number = dnsQueryResult.byteLength
      const udpSizeBuffer: Uint8Array = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff])
      if (webSocket.readyState === WS_READY_STATE_OPEN) {
        if (isAMKHeaderSent) {
          webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer())
        } else {
          webSocket.send(await new Blob([AMKResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer())
          isAMKHeaderSent = true
        }
      }
    }
  })).catch((error) => { })

  const writer: WritableStreamDefaultWriter<Uint8Array> = transformStream.writable.getWriter()
  return {
    write(chunk: Uint8Array) {
      writer.write(chunk)
    }
  }
}

async function HandleTCPOutbound(remoteSocket: RemoteSocketWrapper, addressRemote: string, portRemote: number, rawClientData: Uint8Array, webSocket: WebSocket, AMKResponseHeader: Uint8Array, env: Env): Promise<void> {
  const maxRetryCount = 5
  let retryCount = 0;
  
  async function connectAndWrite(address: string, port: number) {
    const socketAddress: SocketAddress = {
      hostname: address,
      port: port,
    }
    const socketOptions: SocketOptions = {
      allowHalfOpen: false,
      // secureTransport: "starttls",
    }
    const tcpSocket: Socket = connect(socketAddress, socketOptions)//.startTls()
    remoteSocket.value = tcpSocket
    const writer: WritableStreamDefaultWriter<Uint8Array> = tcpSocket.writable.getWriter()
    await writer.write(rawClientData)
    writer.releaseLock()
    return tcpSocket
  }

  async function retry() {
    retryCount++
    if (retryCount > maxRetryCount) {
      return
    }

    if (!proxyList.length) {
      countries = (await env.settings.get("Countries"))?.split(",").filter(t => t.trim().length > 0) || []        
      proxyList = await fetch(proxiesUri).then(r => r.text()).then(t => t.trim().split("\n").filter(t => t.trim().length > 0))
      if (countries.length > 0) {
        proxyList = proxyList.filter(t => {
          const arr = t.split(",")
          if (arr.length > 0) {
            return countries.includes(arr[1])
          }
        })
      }
      proxyList = proxyList.map(ip => ip.split(",")[0])
      console.log(proxyList)
    }
    if (proxyList.length > 0) {
      proxyIP = proxyList[Math.floor(Math.random() * proxyList.length)]
      const tcpSocket: Socket = await connectAndWrite(proxyIP, portRemote)
      RemoteSocketToWS(tcpSocket, webSocket, AMKResponseHeader, retry)
    }
  }

  const tcpSocket: Socket = await connectAndWrite(addressRemote, portRemote)
  RemoteSocketToWS(tcpSocket, webSocket, AMKResponseHeader, retry)
}

async function RemoteSocketToWS(remoteSocket: Socket, webSocket: WebSocket, AMKResponseHeader: ArrayBuffer, retry: (() => Promise<void>) | null): Promise<void> {
  let AMKHeader: ArrayBuffer | null = AMKResponseHeader
  let hasIncomingData: boolean = false
  await remoteSocket.readable
    .pipeTo(
      new WritableStream({
        async write(chunk: Uint8Array, controller: WritableStreamDefaultController) {
          try {
            hasIncomingData = true
            if (webSocket.readyState !== WS_READY_STATE_OPEN) {
              controller.error("webSocket.readyState is not open, maybe close")
            }
            if (AMKHeader) {
              webSocket.send(await new Blob([AMKHeader, chunk]).arrayBuffer())
              AMKHeader = null
            } else {
              webSocket.send(chunk)
            }
          } catch (e) { }
        },
        abort(reason: any) {
          // console.error("remoteConnection!.readable abort", reason)
        },
      })
    )
    .catch((error) => {
      // console.error("remoteSocketToWS has exception ", error.stack || error)
      SafeCloseWebSocket(webSocket)
    })

  if (hasIncomingData === false && retry) {
    retry()
  }
}

function SafeCloseWebSocket(socket: WebSocket): void {
  try {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
      socket.close()
    }
  } catch (error) { }
}

function Base64ToArrayBuffer(base64Str: string): CustomArrayBuffer {
  if (!base64Str) {
    return {
      earlyData: null,
      error: null
    }
  }
  try {
    base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/')
    const decode: string = atob(base64Str)
    const arryBuffer: Uint8Array = Uint8Array.from(decode, (c) => c.charCodeAt(0))
    return {
      earlyData: arryBuffer.buffer,
      error: null
    }
  } catch (error) {
    return {
      earlyData: null,
      error
    }
  }
}

function IsValidAMKUUID(uuid: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid);
}

function Stringify(arr: Uint8Array, offset: number = 0): string {
  const uuid = UnsafeStringify(arr, offset);
  if (!IsValidAMKUUID(uuid)) {
    throw TypeError("Stringified UUID is invalid");
  }
  return uuid;
}

const byteToHex: Array<string> = [];
for (let i = 0; i < 256; ++i) {
  byteToHex.push((i + 256).toString(16).slice(1));
}

function UnsafeStringify(arr: Uint8Array, offset = 0) : string {
  return `${
    byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]]
  }-${
    byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]]
  }-${
    byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]]
  }-${
    byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]]
  }-${
    byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]
  }`.toLowerCase();
}
