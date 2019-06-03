module.exports = WebTorrentRemoteServer

var debug = require('debug')('webtorrent-remote')
var parseTorrent = require('parse-torrent')
var throttle = require('throttleit')
var WebTorrent = require('webtorrent')

/**
 * Runs WebTorrent.
 * Connects to trackers, the DHT, BitTorrent peers, and WebTorrent peers.
 * Controlled by one or more WebTorrentRemoteClients.
 * - send is a function (message) { ... }
 *   Must deliver them message to the WebTorrentRemoteClient
 *   If there is more than one client, you must check message.clientKey
 * - opts is passed to the WebTorrent constructor
 */
function WebTorrentRemoteServer (send, opts) {
  this._send = send
  this._webtorrent = null
  this._clients = {}
  this._torrents = []

  this._webtorrentOpts = opts

  this._canSendStream = opts.canSendStream ? true : false

  this._heartbeatTimeout = opts.heartbeatTimeout != null
    ? opts.heartbeatTimeout
    : 30000

  var updateInterval = opts.updateInterval != null
    ? opts.updateInterval
    : 10000

  if (updateInterval) {
    setInterval(sendUpdates.bind(null, this), updateInterval)
  }
}

// Receives a message from the WebTorrentRemoteClient
// Message contains {clientKey, type, ...}
WebTorrentRemoteServer.prototype.receive = function (message) {
  var clientKey = message.clientKey
  if (!this._clients[clientKey]) {
    debug('adding client, clientKey: ' + clientKey)
    this._clients[clientKey] = {
      clientKey: clientKey,
      heartbeat: Date.now()
    }
  }
  switch (message.type) {
    case 'subscribe':
      return handleSubscribe(this, message)
    case 'add-torrent':
      return handleAddTorrent(this, message)
    case 'create-server':
      return handleCreateServer(this, message)
    case 'heartbeat':
      return handleHeartbeat(this, message)
    case 'destroy':
      return handleDestroy(this, message)
    case 'file-stream':
      return handleFileCreateReadStream(this, message)
    case 'add-webseed':
      return handleAddWebseed(this, message)
    default:
      console.error('ignoring unknown message type: ', message)
  }
}

// Returns the underlying WebTorrent object, lazily creating it if needed
WebTorrentRemoteServer.prototype.webtorrent = function () {
  if (!this._webtorrent) {
    this._webtorrent = new WebTorrent(this._webtorrentOpts)
    addWebTorrentEvents(this)
  }
  return this._webtorrent
}

function send (server, message) {
  debug('sending %o', message)
  server._send(message)
}

// Event handlers for the whole WebTorrent instance
function addWebTorrentEvents (server) {
  server._webtorrent.on('warning', function (e) { sendError(server, null, e, 'warning') })
  server._webtorrent.on('error', function (e) { sendError(server, null, e, 'error') })
}

// Event handlers for individual torrents
function addTorrentEvents (server, torrent) {
  torrent.on('infohash', function () { sendInfo(server, torrent, 'infohash') })
  torrent.on('metadata', function () { sendInfo(server, torrent, 'metadata') })
  torrent.on('download', throttle(function () { sendProgress(server, torrent, 'download') }, 1000))
  torrent.on('upload', throttle(function () { sendProgress(server, torrent, 'upload') }, 1000))
  torrent.on('done', function () { sendProgress(server, torrent, 'done') })
  torrent.on('warning', function (e) { sendError(server, torrent, e, 'warning') })
  torrent.on('error', function (e) { sendError(server, torrent, e, 'error') })
}

// Subscribe does NOT create a new torrent or join a new swarm
// If message.torrentId is missing, it emits 'torrent-subscribed' with {torrent: null}
// If the webtorrent instance hasn't been created at all yet, subscribe won't create it
function handleSubscribe (server, message) {
  var wt = server._webtorrent // Don't create the webtorrent instance
  var clientKey = message.clientKey
  var torrentKey = message.torrentKey

  // See if this torrent is already added
  parseTorrent.remote(message.torrentId, function (err, parsedTorrent) {
    if (err) {
      sendSubscribed(server, null, clientKey, torrentKey)
    } else {
      var torrent = wt && wt.torrents.find(function (t) {
        return t.infoHash === parsedTorrent.infoHash
      })

      // If so, listen for updates
      if (torrent) {
        torrent.clients.push({clientKey: clientKey, torrentKey: torrentKey})
      }

      sendSubscribed(server, torrent, clientKey, torrentKey)
    }
  })
}

// Emits the 'torrent-subscribed' event
function sendSubscribed (server, torrent, clientKey, torrentKey) {
  var response = {
    type: 'torrent-subscribed',
    torrent: null,
    clientKey: clientKey,
    torrentKey: torrentKey
  }

  if (torrent) {
    response.torrent = Object.assign(
      getInfoMessage(server, torrent, '').torrent,
      getProgressMessage(server, torrent, '').torrent
    )
  }

  send(server, response)
}

function handleAddTorrent (server, message) {
  var clientKey = message.clientKey
  var torrentKey = message.torrentKey

  // First, see if we've already joined this swarm
  parseTorrent.remote(message.torrentId, function (err, parsedTorrent) {
    if (err) {
      sendSubscribed(server, null, clientKey, torrentKey)
    } else {
      var infoHash = parsedTorrent.infoHash
      var torrent = server._torrents.find(function (t) {
        return t.infoHash === infoHash
      })

      // If not, add the torrent to the client
      if (!torrent) {
        debug('add torrent: ' + infoHash + ' ' + (parsedTorrent.name || ''))
        torrent = server.webtorrent().add(message.torrentId, message.opts)
        torrent.clients = []
        server._torrents.push(torrent)
        addTorrentEvents(server, torrent)
      }

      // Either way, subscribe this client to future updates for this swarm
      torrent.clients.push({
        clientKey: clientKey,
        torrentKey: torrentKey
      })

      sendSubscribed(server, torrent, clientKey, torrentKey)
    }
  })
}

function handleCreateServer (server, message) {
  var clientKey = message.clientKey
  var torrentKey = message.torrentKey
  var opts = message.opts
  var torrent = getTorrentByKey(server, torrentKey)
  if (!torrent) return

  function done () {
    send(server, {
      clientKey: clientKey,
      torrentKey: torrentKey,
      serverAddress: torrent.serverAddress,
      type: 'server-ready'
    })
  }

  if (torrent.serverAddress) {
    // Server already exists. Call back right away
    done()
  } else if (torrent.pendingServerCallbacks) {
    // Server pending
    // listen() has already been called, but the 'listening' event hasn't fired yet
    torrent.pendingServerCallbacks.push(done)
  } else {
    // Server does not yet exist. Create it, then notify everyone who asked for it
    torrent.pendingServerCallbacks = [done]
    torrent.server = torrent.createServer(opts)
    torrent.server.listen(undefined, 'localhost', undefined, function () {
      torrent.serverAddress = torrent.server.address()
      torrent.pendingServerCallbacks.forEach(function (cb) { cb() })
      delete torrent.pendingServerCallbacks
    })
  }
}

function handleAddWebseed(server, message) {
  var { torrentKey, url } = message
  var torrent = getTorrentByKey(server, torrentKey)
  if (!torrent) return
  torrent.addWebSeed(url)
  debug('handled add webseed', { torrent, url })
}

function getFileByKey(torrent, fileKey) {
  return torrent.files.find(file => file.path === fileKey)
}

function handleFileCreateReadStream (server, message) {
  var clientKey = message.clientKey
  var torrentKey = message.torrentKey
  var fileKey = message.fileKey
  var opts = message.opts
  var torrent = getTorrentByKey(server, torrentKey)
  var file = getFileByKey(torrent, fileKey)
  var streamKey = message.streamKey
  if (!torrent || !file) return

  if (!file.readStreams) file.readStreams = {}
  var stream = file.readStreams[streamKey] = file.createReadStream(opts)
  debug('Handled file create read stream', file, stream)

  // send the raw stream directly if client supports it
  if (server._canSendStream) {
    return send(server, {
      clientKey: clientKey,
      torrentKey: torrentKey,
      fileKey,
      type: 'file-stream-stream',
      streamKey,
      stream
    })
  }

  // send the stream data as messages
  stream.on('data', data => {
    debug('stream data', data)
    send(server, {
      clientKey: clientKey,
      torrentKey: torrentKey,
      fileKey,
      type: 'file-stream-data',
      streamKey,
      data
    })
  })
  stream.on('end', () => {
    send(server, {
      clientKey: clientKey,
      torrentKey: torrentKey,
      fileKey,
      type: 'file-stream-end',
      streamKey
    })
  })
  stream.resume()
}

function handleHeartbeat (server, message) {
  var client = server._clients[message.clientKey]
  if (!client) return console.error('skipping heartbeat for unknown clientKey ' + message.clientKey)
  client.heartbeat = Date.now()
}

// Removes a client from all torrents
// If the torrent has no clients left, destroys the torrent
function handleDestroy (server, message) {
  var clientKey = message.clientKey
  killClient(server, clientKey)
  debug('destroying client ' + clientKey)
}

function sendInfo (server, torrent, type) {
  var message = getInfoMessage(server, torrent, type)
  sendToTorrentClients(server, torrent, message)
}

function sendProgress (server, torrent, type) {
  var message = getProgressMessage(server, torrent, type)
  sendToTorrentClients(server, torrent, message)
}

function getInfoMessage (server, torrent, type) {
  return {
    type: type,
    torrent: {
      name: torrent.name,
      infoHash: torrent.infoHash,
      length: torrent.length,
      files: (torrent.files || []).map(function (file) {
        return {
          name: file.name,
          length: file.length,
          path: file.path,
          offset: file.offset
        }
      })
    }
  }
}

function getProgressMessage (server, torrent, type) {
  return {
    type: type,
    torrent: {
      progress: torrent.progress,
      downloaded: torrent.downloaded,
      uploaded: torrent.uploaded,
      length: torrent.length,
      downloadSpeed: torrent.downloadSpeed,
      uploadSpeed: torrent.uploadSpeed,
      ratio: torrent.ratio,
      numPeers: torrent.numPeers,
      timeRemaining: torrent.timeRemaining
    }
  }
}

function sendError (server, torrent, e, type) {
  var message = {
    type: type, // 'warning' or 'error'
    error: {
      message: e.message,
      stack: e.stack
    }
  }
  if (torrent) sendToTorrentClients(server, torrent, message)
  else sendToAllClients(server, message)
}

function sendUpdates (server) {
  if (server._heartbeatTimeout > 0) {
    removeDeadClients(server, server._heartbeatTimeout)
  }
  server._torrents.forEach(function (torrent) {
    sendProgress(server, torrent, 'update')
  })
}

function removeDeadClients (server, heartbeatTimeout) {
  var now = Date.now()
  for (var clientKey in server._clients) {
    var client = server._clients[clientKey]
    if (now - client.heartbeat <= heartbeatTimeout) continue
    killClient(server, clientKey)
    debug('torrent client died, clientKey: ' + clientKey)
  }
}

function killClient (server, clientKey) {
  // Remove client from server
  delete server._clients[clientKey]

  // Remove clients from torrents
  server._torrents.forEach(function (torrent) {
    torrent.clients = torrent.clients.filter(function (c) {
      return c.clientKey !== clientKey
    })

    if (torrent.clients.length === 0) {
      debug('torrent has no clients left, destroy after 10s: ' + torrent.name)
      setTimeout(destroyTorrent, 10000)
    }

    function destroyTorrent () {
      if (torrent.clients.length > 0) {
        return debug('torrent has new clients, skipping destroy')
      }
      debug('torrent destroyed, all clients died: ' + torrent.name)
      torrent.destroy()

      // Remove destroyed torrents from server
      server._torrents = server._torrents.filter(function (t) {
        return !t.destroyed
      })

      // If the last torrent is gone, kill the whole WebTorrent instance
      if (server._webtorrent && server._torrents.length === 0) {
        server._webtorrent.destroy()
        server._webtorrent = null
        debug('webtorrent destroyed, no torrents left')
      }
    }
  })
}

function sendToTorrentClients (server, torrent, message) {
  torrent.clients.forEach(function (client) {
    var clientMessage = Object.assign({}, message, client)
    send(server, clientMessage)
  })
}

function sendToAllClients (server, message) {
  for (var clientKey in server._clients) {
    var clientMessage = Object.assign({}, message, {clientKey: clientKey})
    send(server, clientMessage)
  }
}

function getTorrentByKey (server, torrentKey) {
  var torrent = server.webtorrent().torrents.find(function (t) { return hasTorrentKey(t, torrentKey) })
  if (!torrent) {
    var message = 'missing torrentKey: ' + torrentKey
    sendError(server, null, {message: message}, 'warning')
  }
  return torrent
}

// Each torrent corresponds to *one or more* torrentKeys That's because clients
// generate torrentKeys independently, and we might have two clients that both
// added a torrent with the same infoHash. (In that case, two RemoteTorrent objects
// correspond to the same WebTorrent torrent object.)
function hasTorrentKey (torrent, torrentKey) {
  return torrent.clients.some(function (c) { return c.torrentKey === torrentKey })
}