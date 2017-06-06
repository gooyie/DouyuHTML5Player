let channelId = 0;
let localConnection;

class StreamReader {

  constructor(port) {
    this._channelId = channelId++ & 0x3ff;
    let dataChannel = localConnection.createDataChannel('dataChannel', {id: this._channelId});
    this._dataChannel = dataChannel;
    this._port = port;
    this._cansend = false;
    this._onCanSend = () => this._cansend = true;

    dataChannel.onopen = this._onopen.bind(this);
    dataChannel.onclose = this._onclose.bind(this);
    dataChannel.onerror = this._onerror.bind(this);
    dataChannel.onmessage = this._onmessage.bind(this);
  }

  read() {
    return new Promise((resolve, reject) => {
      this._readCallback = resolve;
      this._errorCallback = reject;
      this._send('read');
    })
  }

  cancel() {
    return new Promise((resolve, reject) => {
      this._cancelCallback = resolve;
      this._errorCallback = reject;
      this._send('cancel');
    })
  }

  _onopen(event) {
    console.log(`[dataChannel] opened data channel ${this._channelId}`);
  }

  _onclose(event) {
    console.log(`[dataChannel] closed data channel ${this._channelId}`);
  }

  _send(...args) {
    if (this._cansend) {
      this._dataChannel.send(...args);
    } else {
      this._onCanSend = () => {
        this._cansend = true;
        this._dataChannel.send(...args);
      };
    }
  }

  _onmessage(event) {
    // console.log('[dataChannel] received', event.data);
    let data = event.data;

    if (data instanceof ArrayBuffer) {
      this._readCallback({done: false, value: new Uint8Array(data)});
    } else if (data === 'done') {
      this._dataChannel.close();
      this._readCallback({done: true, value: undefined});
    } else if (data === 'canceled') {
      this._dataChannel.close();
      this._cancelCallback();
    } else if (data === 'remoteOpened') {
      this._port('stream', [this._channelId]).then(this._onCanSend);
    }
  }

  _onerror(event) {
    console.error(`[dataChannel] error of data channel ${this._channelId}`, event);
    this._errorCallback(new Error(event));
  }

}

function createConnection() {
  let port = chrome.runtime.connect({name: 'signaling'});

  let localConnection = new RTCPeerConnection();
  let initChannel = localConnection.createDataChannel('initChannel', {id: channelId++ & 0x3ff});

  window.addEventListener('unload', () => {
    localConnection.close();
    port.disconnect();
  });

  localConnection.onicecandidate = (event) => {
    if (event.candidate) {
      port.postMessage(event.candidate.toJSON());
    }
  }

  initChannel.onopen = (event) => {
    console.log('[initChannel] opened', event);
    initChannel.close();
  }

  initChannel.onclose = (event) => {
    console.log('[initChannel] closed', event);
  }

  port.onMessage.addListener((msg = {}) => {
    console.log('[signaling]', msg);
      try {
        if (msg.status && msg.status === 'connected') {
          localConnection.createOffer().then(offer => {
            port.postMessage(offer.toJSON());
            localConnection.setLocalDescription(offer);
          });
        } else if (msg.type && msg.type === 'answer') {
          localConnection.setRemoteDescription(new RTCSessionDescription(msg));
        } else if (msg.candidate) {
          localConnection.addIceCandidate(new RTCIceCandidate(msg));
        }
      } catch (err) {
        console.error(err.stack);
      }
  });

  port.onDisconnect.addListener(port => {
    console.log('[signaling] disconnected');
  });

  return localConnection;
}

function hookFetchCode () {
  let self = this
  const convertHeader = function convertHeader(headers) {
    let out = new Headers()
    for (let key of Object.keys(headers)) {
      out.set(key, headers[key])
    }
    return out
  }
  const hideHookStack = stack => {
    return stack.replace(/^\s*at\s.*?hookfetch\.js:\d.*$\n/mg, '')
  }
  const wrapPort = function wrapPort (port) {
    let curMethod = ''
    let curResolve = null
    let curReject = null
    let stack = new Error().stack
    port.onMessage.addListener(msg => {
      if (msg.method === curMethod) {
        if (msg.err) {
          // TODO 潜在安全性问题= =
          let ctor = new Function('return ' + msg.err.name)()
          let err = ctor(msg.err.message)
          err.stack = hideHookStack(stack)
          // console.log('fetch err', err)
          curReject(err)
        } else {
          curResolve.apply(null, msg.args)
        }
      } else {
        console.error('wtf?')
      }
    })
    return function (method, args) {
      return new Promise((resolve, reject) => {
        curMethod = method
        curResolve = resolve
        curReject = reject
        port.postMessage({
          method: method,
          args: args
        })
      })
    }
  }
  const bgFetch = function bgFetch(...args) {
    const port = wrapPort(chrome.runtime.connect({name: "fetch"}))
    return port('fetch', args).then(r => {
      console.log(r)
      let hasReader = false
      const requireReader = function (after) {
        if (hasReader) {
          return Promise.resolve().then(after)
        } else {
          return port('body.getReader').then(() => hasReader = true).then(after)
        }
      }

      r.json = () => port('json')
      r.headers = convertHeader(r.headers)
      r.body = {
        getReader () {
          console.log('[getReader]', args[0])
          return new StreamReader(port)
          // return {
            // read () {
              // return requireReader(() => port('reader.read')).then(r => {
                // if (r.done == false) {
                  // r.value = new Uint8Array(r.value)
                // }
                // return r
              // })
            // },
            // cancel () {
              // return requireReader(() => port('reader.cancel'))
            // }
          // }
        }
      }
      return r
    })
  }
  function hookFetch () {
    if (fetch !== bgFetch) {
      fetch = bgFetch
    }
  }
  const oldBlob = Blob
  const newBlob = function newBlob(a, b) {
    a[0] = `(${hookFetchCode})();${a[0]}`
    console.log('new blob', a, b)
    return new oldBlob(a, b)
  }
  // if(self.document !== undefined) {
  //   if (self.Blob !== newBlob) {
  //     self.Blob = newBlob
  //   }
  // }

  hookFetch()
}

if (typeof chrome !== 'undefined') {
  localConnection = createConnection()
  hookFetchCode()
}
