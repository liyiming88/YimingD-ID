'use strict';
const fetchJsonFile = await fetch('./api.json');
const DID_API = await fetchJsonFile.json();

if (DID_API.key == '🤫') alert('Please put your api key inside ./api.json and restart..');

const RTCPeerConnection = (
  window.RTCPeerConnection ||
  window.webkitRTCPeerConnection ||
  window.mozRTCPeerConnection
).bind(window);

let peerConnection;
let pcDataChannel;
let streamId;
let sessionId;
let sessionClientAnswer;

let statsIntervalId;
let lastBytesReceived;
let videoIsPlaying = false;
let streamVideoOpacity = 0;

// Set this variable to true to request stream warmup upon connection to mitigate potential jittering issues
const stream_warmup = true;
let isStreamReady = !stream_warmup;

const idleVideoElement = document.getElementById('idle-video-element');
const streamVideoElement = document.getElementById('stream-video-element');
idleVideoElement.setAttribute('playsinline', '');
streamVideoElement.setAttribute('playsinline', '');

const CONFIG = {
  API_KEY: 'sk-LtWfcckYXtlxF1pv5jWMaAfY533vpStRjfxlHRc1xBehGlws', // 替换为你的实际API密钥
  API_URL: 'https://api.moonshot.cn/v1/chat/completions',
  MODEL: 'moonshot-v1-8k',
  TEMPERATURE: 0.7
};

const presenterInputByService = {
  talks: {
    source_url: 'https://create-images-results.d-id.com/DefaultPresenters/Emma_f/v1_image.jpeg',
  },
  clips: {
    presenter_id: 'v2_public_alex@qcvo4gupoy',
    driver_id: 'e3nbserss8',
  },
};

const PRESENTER_TYPE = DID_API.service === 'clips' ? 'clip' : 'talk';

const connectButton = document.getElementById('connect-button');
let ws;

let messageHistory = [];


const chatButton = document.getElementById('chat-button');

chatButton.onclick = () => {
  const chatWindow = document.getElementById('chat-window');
  chatWindow.classList.toggle('visible');
}

// 点击窗口外部区域关闭聊天窗口
document.addEventListener('click', function(event) {
  const chatWindow = document.getElementById('chat-window');
  const chatButton = document.getElementById('chat-button');
  
  if (!chatWindow.contains(event.target) && !chatButton.contains(event.target)) {
      chatWindow.classList.remove('visible');
  } else {
    setupStream()
  }
});

// 创建WebSocket连接，创建WebRTC连接
async function setupStream() {
  if (peerConnection && peerConnection.connectionState === 'connected') {
    return;
  }

  stopAllStreams();
  closePC();

  try {
    // Step 1: Connect to WebSocket
    ws = await connectToWebSocket(DID_API.websocketUrl, DID_API.key);

    // Step 2: Send "init-stream" message to WebSocket
    const startStreamMessage = {
      type: 'init-stream',
      payload: {
        ...presenterInputByService[DID_API.service],
        presenter_type: PRESENTER_TYPE,
      },
    };
    sendMessage(ws, startStreamMessage);

    // Step 3: Handle WebSocket responses by message type
    ws.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      switch (data.messageType) {
        case 'init-stream':
          const { id: newStreamId, offer, ice_servers: iceServers, session_id: newSessionId } = data;
          streamId = newStreamId;
          sessionId = newSessionId;

          try {
            sessionClientAnswer = await createPeerConnection(offer, iceServers);
            // Step 4: Send SDP answer to WebSocket
            const sdpMessage = {
              type: 'sdp',
              payload: {
                answer: sessionClientAnswer,
                session_id: sessionId,
                presenter_type: PRESENTER_TYPE,
              },
            };
            sendMessage(ws, sdpMessage);
          } catch (e) {
            console.error('Error during streaming setup', e);
            stopAllStreams();
            closePC();
            return;
          }
          break;

        case 'sdp':
          console.log('SDP message received:', event.data);
          break;

        case 'delete-stream':
          console.log('Stream deleted:', event.data);
          break;
      }
    };
  } catch (error) {
    console.error('Failed to connect and set up stream:', error.type);
  }
}

//获取send 按钮
const submitButton = document.getElementById('submit-button');

//定义点击send按钮之后的逻辑
submitButton.onclick = async () => {
  const input = document.getElementById('userInput');
  const message = input.value.trim();
  if (!message) return;

  addMessageToChat('user', message);
  input.value = '';

  try {
    console.log('Sending message:', message);
    const response = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.API_KEY}`
      },
      body: JSON.stringify({
        model: CONFIG.MODEL,
        messages: [{ role: 'system', content: `your output has no emoji. And keep your words brief.
          You are a professional AI customer service assistant, specializing in helping users with questions related to online pension withdrawal in UK.And keep your words brief.` }, ...messageHistory, { role: 'user', content: message }],
        temperature: CONFIG.TEMPERATURE
      })
    });

    if (!response.ok) {
      throw new Error(`API请求失败: ${response.status}`);
    }

    const data = await response.json();
    const text = data.choices[0].message.content;

    processTextAndSendMessages(text, ws);
    
    addMessageToChat('assistant', text);
    messageHistory.push(
      { role: 'user', content: message },
      { role: 'assistant', content: text }
    );
  } catch (error) {
    addMessageToChat('system', `错误: ${error.message}`);
  }
};

//把消息附加到对话框中
function addMessageToChat(role, content) {
  const chatBox = document.getElementById('chatBox');
  const messageDiv = document.createElement('div');
  
  messageDiv.className = `message ${role}-message`;
  messageDiv.textContent = content;
  
  chatBox.appendChild(messageDiv);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// 绑定回车键事件
document.getElementById('userInput').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') submitButton.onclick();
});

function onIceGatheringStateChange() {
}

function onIceCandidate(event) {
  console.log('onIceCandidate', event);
  if (event.candidate) {
    const { candidate, sdpMid, sdpMLineIndex } = event.candidate;
    sendMessage(ws, {
      type: 'ice',
      payload: {
        session_id: sessionId,
        candidate,
        sdpMid,
        sdpMLineIndex,
      },
    });
  } else {
    sendMessage(ws, {
      type: 'ice',
      payload: {
        stream_id: streamId,
        session_id: sessionId,
        presenter_type: PRESENTER_TYPE,
      },
    });
  }
}
function onIceConnectionStateChange() {
  if (peerConnection.iceConnectionState === 'failed' || peerConnection.iceConnectionState === 'closed') {
    stopAllStreams();
    closePC();
  }
}
function onConnectionStateChange() {
  // not supported in firefox
  console.log('peerConnection', peerConnection.connectionState);

  if (peerConnection.connectionState === 'connected') {
    playIdleVideo();
    updateConnectionStatus();
    
    /**
     * A fallback mechanism: if the 'stream/ready' event isn't received within 5 seconds after asking for stream warmup,
     * it updates the UI to indicate that the system is ready to start streaming data.
     */
    setTimeout(() => {
      if (!isStreamReady) {
        console.log('forcing stream/ready');
        isStreamReady = true;
        // Avatar主动发起问候
        const username = document.getElementById('username').value || 'Guest';
        const textToSpeech = document.getElementById('')
        const welcomeMessage = `Hello, ${username}, how can I assist you today?`;
        addMessageToChat('assistant', welcomeMessage);
        processTextAndSendMessages(welcomeMessage, ws);
      }
    }, 2000);
    
  }
}

function onSignalingStateChange() {
  
}

function onVideoStatusChange(videoIsPlaying, stream) {
  let status;

  if (videoIsPlaying) {
    status = 'streaming';
    streamVideoOpacity = isStreamReady ? 1 : 0;
    setStreamVideoElement(stream);
  } else {
    status = 'empty';
    streamVideoOpacity = 0;
  }

  streamVideoElement.style.opacity = streamVideoOpacity;
  idleVideoElement.style.opacity = 1 - streamVideoOpacity;

}

function onTrack(event) {
  /**
   * The following code is designed to provide information about wether currently there is data
   * that's being streamed - It does so by periodically looking for changes in total stream data size
   *
   * This information in our case is used in order to show idle video while no video is streaming.
   * To create this idle video use the POST https://api.d-id.com/talks (or clips) endpoint with a silent audio file or a text script with only ssml breaks
   * https://docs.aws.amazon.com/polly/latest/dg/supportedtags.html#break-tag
   * for seamless results use `config.fluent: true` and provide the same configuration as the streaming video
   */

  if (!event.track) return;

  statsIntervalId = setInterval(async () => {
    const stats = await peerConnection.getStats(event.track);
    stats.forEach((report) => {
      if (report.type === 'inbound-rtp' && report.kind === 'video') {
        const videoStatusChanged = videoIsPlaying !== report.bytesReceived > lastBytesReceived;

        if (videoStatusChanged) {
          videoIsPlaying = report.bytesReceived > lastBytesReceived;
          onVideoStatusChange(videoIsPlaying, event.streams[0]);
        }
        lastBytesReceived = report.bytesReceived;
      }
    });
  }, 500);
}

function onStreamEvent(message) {
  /**
   * This function handles stream events received on the data channel.
   * The 'stream/ready' event received on the data channel signals the end of the 2sec idle streaming.
   * Upon receiving the 'ready' event, we can display the streamed video if one is available on the stream channel.
   * Until the 'ready' event is received, we hide any streamed video.
   * Additionally, this function processes events for stream start, completion, and errors. Other data events are disregarded.
   */

  if (pcDataChannel.readyState === 'open') {
    let status;
    const [event, _] = message.data.split(':');

    switch (event) {
      case 'stream/started':
        status = 'started';
        break;
      case 'stream/done':
        status = 'done';
        break;
      case 'stream/ready':
        status = 'ready';
        break;
      case 'stream/error':
        status = 'error';
        break;
      default:
        status = 'dont-care';
        break;
    }

    // Set stream ready after a short delay, adjusting for potential timing differences between data and stream channels
    if (status === 'ready') {
      setTimeout(() => {
        console.log('stream/ready');
        isStreamReady = true;
       
      }, 1000);
    } else {
      console.log(event);
     
    }
  }
}

async function createPeerConnection(offer, iceServers) {
  if (!peerConnection) {
    peerConnection = new RTCPeerConnection({ iceServers });
    pcDataChannel = peerConnection.createDataChannel('JanusDataChannel');
    peerConnection.addEventListener('icegatheringstatechange', onIceGatheringStateChange, true);
    peerConnection.addEventListener('icecandidate', onIceCandidate, true);
    peerConnection.addEventListener('iceconnectionstatechange', onIceConnectionStateChange, true);
    peerConnection.addEventListener('connectionstatechange', onConnectionStateChange, true);
    peerConnection.addEventListener('signalingstatechange', onSignalingStateChange, true);
    peerConnection.addEventListener('track', onTrack, true);
    pcDataChannel.addEventListener('message', onStreamEvent, true);
  }

  await peerConnection.setRemoteDescription(offer);
  console.log('set remote sdp OK');

  const sessionClientAnswer = await peerConnection.createAnswer();
  console.log('create local sdp OK');

  await peerConnection.setLocalDescription(sessionClientAnswer);
  console.log('set local sdp OK');

  return sessionClientAnswer;
}

function setStreamVideoElement(stream) {
  if (!stream) return;

  streamVideoElement.srcObject = stream;
  streamVideoElement.loop = false;
  streamVideoElement.mute = !isStreamReady;

  // safari hotfix
  if (streamVideoElement.paused) {
    streamVideoElement
      .play()
      .then((_) => {})
      .catch((e) => {});
  }
}

function playIdleVideo() {
  idleVideoElement.src = DID_API.service == 'clips' ? 'alex_v2_idle.mp4' : 'emma_idle.mp4';
}

function stopAllStreams() {
  if (streamVideoElement.srcObject) {
    console.log('stopping video streams');
    streamVideoElement.srcObject.getTracks().forEach((track) => track.stop());
    streamVideoElement.srcObject = null;
    streamVideoOpacity = 0;
  }
}

function closePC(pc = peerConnection) {
  if (!pc) return;
  console.log('stopping peer connection');
  pc.close();
  pc.removeEventListener('icegatheringstatechange', onIceGatheringStateChange, true);
  pc.removeEventListener('icecandidate', onIceCandidate, true);
  pc.removeEventListener('iceconnectionstatechange', onIceConnectionStateChange, true);
  pc.removeEventListener('connectionstatechange', onConnectionStateChange, true);
  pc.removeEventListener('signalingstatechange', onSignalingStateChange, true);
  pc.removeEventListener('track', onTrack, true);
  pcDataChannel.removeEventListener('message', onStreamEvent, true);

  clearInterval(statsIntervalId);
  isStreamReady = !stream_warmup;
  streamVideoOpacity = 0;
  console.log('stopped peer connection');
  if (pc === peerConnection) {
    peerConnection = null;
  }
}

const maxRetryCount = 3;
const maxDelaySec = 4;

async function connectToWebSocket(url, token) {
  return new Promise((resolve, reject) => {
    const wsUrl = `${url}?authorization=Basic ${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('WebSocket connection opened.');
      resolve(ws);
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
      reject(err);
    };

    ws.onclose = () => {
      console.log('WebSocket connection closed.');
    };
  });
}

function sendMessage(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  } else {
    console.error('WebSocket is not open. Cannot send message.');
  }
}

function getChunk(arrayBuffer, chunkIndex, totalChunks, chunkSize) {
  if (chunkIndex === totalChunks) {
    return new Uint8Array(0); // Indicates end of audio stream
  }

  const start = chunkIndex * chunkSize;
  const end = Math.min(start + chunkSize, arrayBuffer.byteLength);
  return new Uint8Array(arrayBuffer.slice(start, end));
}

function updateConnectionStatus() {
  const connectionStatusElement = document.getElementById('connectionStatus');
  if (connectionStatusElement) {
    connectionStatusElement.textContent = 'Start to chat with AI assistant';
  }
}

function processTextAndSendMessages(text, ws) {
  const chunks = text.split(' ');

  // Indicates end of text stream
  chunks.push('');

  for (const [_, chunk] of chunks.entries()) {
    const streamMessage = {
      type: 'stream-text',
      payload: {
        script: {
          type: 'text',
          input: chunk,
          provider: {
            type: 'microsoft',
            voice_id: 'en-US-JennyNeural ',
          },
          ssml: true,
        },
        config: {
          stitch: true,
        },
        apiKeysExternal: {
          elevenlabs: { key: '' },
        },
        background: {
          color: '#FFFFFF',
        },
        session_id: sessionId,
        stream_id: streamId,
        presenter_type: PRESENTER_TYPE,
      },
    };
    sendMessage(ws, streamMessage);
  }
}