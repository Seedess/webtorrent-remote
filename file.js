const { EventEmitter } = require('events')
const { PassThrough } = require('stream')
const debug = console.log.bind(console, 'webtorrent-remote:file ')

class File extends EventEmitter {
    constructor(torrent, file) {
        super()

        this._torrent = torrent
        this._destroyed = false

        this.name = file.name
        this.path = file.path
        this.length = file.length
        this.offset = file.offset

        this.done = false
        this.streamKey = generateUniqueKey()

        const start = file.offset
        const end = start + file.length - 1

        this._startPiece = start / this._torrent.pieceLength | 0
        this._endPiece = end / this._torrent.pieceLength | 0

        if (this.length === 0) {
            this.done = true
            this.emit('done')
        }
    }

    get key() {
        return this.path
    }

    get downloaded() {
        this._torrent.client._send({
            type: 'file-info-downloaded',
            clientKey: this._torrent.client.clientKey,
            torrentKey: this._torrent.key,
            fileKey: this.key
          })
    }

    get progress() {
        return this.length ? this.downloaded / this.length : 0
    }

    select(priority) {
        if (this.length === 0) return
        this._torrent.select(this._startPiece, this._endPiece, priority)
    }

    deselect() {
        if (this.length === 0) return
        this._torrent.deselect(this._startPiece, this._endPiece, false)
    }

    createReadStream(opts) {
        debug('createReadStream', { opts })
        this._torrent.client._send({
            type: 'file-stream',
            clientKey: this._torrent.client.clientKey,
            torrentKey: this._torrent.key,
            fileKey: this.key,
            streamKey: this.streamKey,
            opts
          })
        const stream = new PassThrough()
        this.on('stream-data', message => {
            stream.write(message.data)
        })
        this.on('stream-end', () => {
            stream.end()
        })
        this.on('stream', message => {
            message.stream.pipeThrough(stream)
        })
        return stream
    }

    getBuffer(cb) {
        streamToBuffer(this.createReadStream(), this.length, cb)
    }

    getBlob(cb) {
        if (typeof window === 'undefined') throw new Error('browser-only method')
        streamToBlob(this.createReadStream(), this._getMimeType(), cb)
    }

    getBlobURL(cb) {
        if (typeof window === 'undefined') throw new Error('browser-only method')
        streamToBlobURL(this.createReadStream(), this._getMimeType(), cb)
    }

    appendTo(elem, opts, cb) {
        if (typeof window === 'undefined') throw new Error('browser-only method')
        render.append(this, elem, opts, cb)
    }

    renderTo(elem, opts, cb) {
        if (typeof window === 'undefined') throw new Error('browser-only method')
        render.render(this, elem, opts, cb)
    }

    _getMimeType() {
        return render.mime[path.extname(this.name).toLowerCase()]
    }

    _destroy() {
        this._destroyed = true
        this._torrent = null
    }
}

function generateUniqueKey () {
    return Math.random().toString(16).slice(2)
  }

module.exports = File

