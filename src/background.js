let connections = new Map();
let dataChannels = new WeakMap();

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'signaling') return;

  const tabId = port.sender.tab.id;
  console.log(`[${tabId}][signaling] connected`);
  let remoteConnection;

  port.onMessage.addListener((msg = {}) => {
    console.log(`[${tabId}][signaling]`, msg);
    (async () => {
      try {
        if (msg.type && msg.type === 'offer') {
          remoteConnection = new RTCPeerConnection();
          connections.set(tabId, remoteConnection);
          console.log(`updated peer connections`, connections);
          remoteConnection.onicecandidate = (event) => {
            if (event.candidate) {
                port.postMessage(event.candidate.toJSON());
            }
          };

          remoteConnection.ondatachannel = (event) => {
            if (event.channel.label === 'initChannel') {
              console.log(`[${tabId}][ondatachannel] got init channel`);
              let initChannel = event.channel;
              initChannel.onopen = (event) => {
                console.log(`[${tabId}][initChannel] opened`);
              };
              initChannel.onclose = (event) => {
                console.log(`[${tabId}][initChannel] closed`);
              };
            } else if (event.channel.label === 'dataChannel') {
              let dataChannel = event.channel;
              let id = event.channel.id;
              console.log(`[${tabId}][ondatachannel] got data channel ${id}`);

              if (dataChannels.has(remoteConnection)) {
                dataChannels.get(remoteConnection).set(id, event.channel);
                console.log(`[${tabId}] updated data channels`, dataChannels.get(remoteConnection));
              } else {
                dataChannels.set(remoteConnection, new Map([[id, event.channel]]));
                console.log(`[${tabId}] updated data channels`, dataChannels.get(remoteConnection));
              }

              dataChannel.onopen = (event) => {
                console.log(`[${tabId}][dataChannel] opened data channel ${id}`);
                event.currentTarget.send('remoteOpened');
              };
              dataChannel.onclose = (event) => {
                  console.log(`[${tabId}][dataChannel] closed data channel ${id}`);
              };
              dataChannel.onerror = (event) => {
                console.error(`[${tabId}][dataChannel] error of data channel ${id}`, event);
              };
            }
          };

          await remoteConnection.setRemoteDescription(new RTCSessionDescription(msg));
          let answer = await remoteConnection.createAnswer();
          port.postMessage(answer.toJSON());
          await remoteConnection.setLocalDescription(answer);
        } else if (msg.candidate) {
          await remoteConnection.addIceCandidate(new RTCIceCandidate(msg));
        }
      } catch (err) {
        console.error(err.stack);
      }
    })();
  });

  port.onDisconnect.addListener(port => {
    console.log(`[${tabId}][signaling] disconnected`);
    if (connections.has(tabId)) {
      let connection = connections.get(tabId);
      connections.delete(tabId);
      console.info(`[${tabId}][deleted peer connection]`, connection);
      console.log(`updated peer connections`, connections);
    }
  });

  port.postMessage({status: 'connected'});
});

function convertHeader (headers) {
  let out = {}
  for (let key of headers.keys()) {
    out[key] = headers.get(key)
  }
  return out
}
chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'fetch') {
    console.log('new fetch port', port)
    let response
    let reader
    port.onDisconnect.addListener(() => {
      reader && reader.cancel()
    })
    port.onMessage.addListener(msg => {
      // console.log('fetch new msg', msg)
      let chain = Promise.resolve()
      if (msg.method === 'fetch') {
        chain = chain.then(() => fetch.apply(null, msg.args)).then(r => {
          response = r
          console.log('response', r)
          return {
            bodyUsed: r.bodyUsed,
            ok: r.ok,
            status: r.status,
            statusText: r.statusText,
            type: r.type,
            url: r.url,
            headers: convertHeader(r.headers)
          }
        })
      } else if (msg.method === 'json') {
        chain = chain.then(() => response.json())
      } else if (msg.method === 'stream') {
        reader = response.body.getReader();

        chain = chain.then(() => {
          let tabId = port.sender.tab.id;
          let channelId = msg.args[0];
          let dataChannel = dataChannels.get(connections.get(tabId)).get(channelId);

          dataChannel.onmessage = (event) => {
            // console.log(`[${tabId}][dataChannel] data channel ${channelId} received`, event.data);
            let channel = event.currentTarget;

            if (event.data === 'read') {
              reader.read().then(r => {
                if (r.done) {
                  channel.send('done');
                  dataChannels.get(connections.get(tabId)).delete(channelId);
                  console.log(`[${tabId}] updated data channels`, dataChannels.get(connections.get(tabId)));
                } else {
                  channel.send(r.value);
                }
              });
            } else if (event.data === 'cancel') {
              reader.cancel().then(() => {
                channel.send('canceled');
                dataChannels.get(connections.get(tabId)).delete(channelId);
                console.log(`[${tabId}] updated data channels`, dataChannels.get(connections.get(tabId)));
              });
            }
          };
        });
      } else if (msg.method === 'body.getReader') {
          reader = response.body.getReader()
          console.log('reader', reader)
      } else if (msg.method === 'reader.read') {
        chain = chain.then(() => reader.read()).then(r => {
          // console.log('read', r)
          if (r.done === false) {
            r.value = Array.from(r.value)
          }
          return r
        })
      } else if (msg.method === 'reader.cancel') {
        chain = chain.then(() => reader.cancel())
      } else {
        port.disconnect()
        return
      }
      chain.then((...args) => {
        const outMsg = {
          method: msg.method,
          args: args
        }
        // console.log('fetch send msg', outMsg)
        port.postMessage(outMsg)
      }).catch(e => {
        console.log(e)
        port.postMessage({
          method: msg.method,
          err: {
            name: e.name,
            message: e.message,
            stack: e.stack,
            string: e.toString()
          }
        })
      })
    })
  }
})
chrome.pageAction.onClicked.addListener(tab => {
  chrome.tabs.sendMessage(tab.id, {
    type: 'toggle'
  })
})
chrome.tabs.onUpdated.addListener((id, x, tab) => {
	if (/https?:\/\/[^\/]*\.douyu\.com(\/|$)/.test(tab.url)) {
		chrome.pageAction.show(tab.id)
	} else {
		chrome.pageAction.hide(tab.id)
	}
})
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.type) {
    case 'disable':
      chrome.pageAction.setIcon({
        tabId: sender.tab.id,
        path: 'disabled.png'
      })
      break
  }
})
