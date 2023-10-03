import { pack, unpack } from "peerjs-js-binarypack";
import logger from "../logger";
import { DataConnection, SendData } from "./DataConnection";
import { BinaryPackChunk, BinaryPackChunker, concatArrayBuffers, isBinaryPackChunk } from "./BufferedConnection/binaryPackChunker";


export class BufferedNotifyConnection extends DataConnection {
    readonly serialization = 'notify';
    private readonly chunker = new BinaryPackChunker();

    private _chunkedData: {
        [id: number]: {
            data: Uint8Array[];
            count: number;
            total: number;
        };
    } = {};

    private _buffer: BinaryPackChunk[] = [];
    private _bufferSize = 0;
    private _buffering = false;

    public get bufferSize(): number {
        return this._bufferSize;
    }

    public get nextID(): number {
        return this.chunker.nextID;
    }

    public override _initializeDataChannel(dc: RTCDataChannel) {
        super._initializeDataChannel(dc);
        this.dataChannel.binaryType = "arraybuffer";
        this.dataChannel.addEventListener("message", (e) =>
            this._handleDataMessage(e),
        );
    }

    // Handles a DataChannel message.
    protected _handleDataMessage({ data }: { data: Uint8Array }): void {
        const deserializedData = unpack(data);

        // PeerJS specific message
        const peerData = deserializedData["__peerData"];
        if (peerData) {
            if (peerData.type === "close") {
                this.close();
                return;
            }
        }

        if (isBinaryPackChunk(deserializedData)) {
            this._handleChunk(deserializedData);
            return;
        }

        this.emit("data", deserializedData);
    }

    private _handleChunk(data: BinaryPackChunk): void {
        const id = data.id;
        const chunkInfo = this._chunkedData[id] || {
            data: [],
            count: 0,
            total: data.total,
        };

        chunkInfo.data[data.n] = new Uint8Array(data.data);
        chunkInfo.count++;
        this._chunkedData[id] = chunkInfo;
        // TODO: Send out a receive notification event here

        if (chunkInfo.total === chunkInfo.count) {
            // Clean up before making the recursive call to `_handleDataMessage`.
            delete this._chunkedData[id];

            // We've received all the chunks--time to construct the complete data.
            // const data = new Blob(chunkInfo.data);
            const data = concatArrayBuffers(chunkInfo.data);
            this._handleDataMessage({ data });
        }
    }

    public SendWithCallback(data: any, callback: (chunk: BinaryPackChunk) => void): SendData {
        throw new Error("Method not implemented.");
    }

    protected _send(data: any): void {
        const blob = pack(data);

        if (blob.byteLength > this.chunker.chunkedMTU) {

            const blobs = this.chunker.chunk(blob);
            logger.log(`DC#${this.connectionId} Try to send ${blobs.length} chunks...`);

            for (const blob of blobs) {
                this._bufferedSend(blob);
            }
            return;

        }
        //We send everything in one chunk
        const msg = this.chunker.singleChunk(blob);
        this._bufferedSend(msg);
    }

    protected _bufferedSend(msg: BinaryPackChunk): void {
        if (this._buffering || !this._trySend(msg)) {
            this._buffer.push(msg);
            this._bufferSize = this._buffer.length;
        }
    }

    // Returns true if the send succeeds.
    private _trySend(msg: BinaryPackChunk): boolean {
        if (!this.open) {
            return false;
        }

        if (this.dataChannel.bufferedAmount > DataConnection.MAX_BUFFERED_AMOUNT) {
            this._buffering = true;
            setTimeout(() => {
                this._buffering = false;
                this._tryBuffer();
            }, 50);

            return false;
        }

        try {
            // Send notification
            this.emit("sentChunk", { id: msg.id, n: msg.n, total: msg.total });
            const msgPacked = pack(msg as any);
            this.dataChannel.send(msgPacked);
        } catch (e) {
            logger.error(`DC#:${this.connectionId} Error when sending:`, e);
            this._buffering = true;

            this.close();

            return false;
        }

        return true;
    }

    // Try to send the first message in the buffer.
    private _tryBuffer(): void {
        if (!this.open) {
            return;
        }

        if (this._buffer.length === 0) {
            return;
        }

        const msg = this._buffer[0];

        if (this._trySend(msg)) {
            this._buffer.shift();
            this._bufferSize = this._buffer.length;
            this._tryBuffer();
        }
    }

    public override close(options?: { flush?: boolean }) {
        if (options?.flush) {
            this.send({
                __peerData: {
                    type: "close",
                },
            });
            return;
        }
        this._buffer = [];
        this._bufferSize = 0;
        super.close();
    }
}
