import { util } from "./util";
import logger from "./logger";
import { Negotiator } from "./negotiator";
import { ConnectionType, SerializationType, ServerMessageType } from "./enums";
import { Peer } from "./peer";
import { BaseConnection } from "./baseconnection";
import { ServerMessage } from "./servermessage";
import { EncodingQueue } from "./encodingQueue";
import type { DataConnection as IDataConnection } from "./dataconnection";

type DataConnectionEvents = {
	/**
	 * Emitted when data is received from the remote peer.
	 */
	// TODO: Fix type
	data: (data: unknown) => void;
	/**
	 * Emitted when the connection is established and ready-to-use.
	 */
	open: () => void;
};
export interface ProgressReport {
	// Integer
	id: number;
	// Float (0-1)
	progress: number;
}

export interface MessageMeta {
	type: "chunk" | "array" | "string";
	chunkData?: {
		count: number;
		total: number;
		chunkId: number;
	}
}

export interface BlobMessage {
	data: Blob,
	meta: MessageMeta,

}

export interface ArrayBuffMessage {
	data: ArrayBuffer,
	meta: MessageMeta,
}

export type Message = string | BlobMessage | ArrayBuffMessage;

/**
 * Wraps a DataChannel between two Peers.
 */
export class DataConnection
	extends BaseConnection<DataConnectionEvents>
	implements IDataConnection {
	private static readonly ID_PREFIX = "dc_";
	private static readonly MAX_BUFFERED_AMOUNT = 8 * 1024 * 1024;

	private _negotiator: Negotiator<DataConnectionEvents, DataConnection>;
	readonly label: string;
	readonly serialization: SerializationType;
	readonly reliable: boolean;
	stringify: (data: any) => string = JSON.stringify;
	parse: (data: string) => any = JSON.parse;

	get type() {
		return ConnectionType.Data;
	}

	public _buffer: any[] = [];
	// private _bufferSize = 0;
	private _buffering = false;
	// Used to recreate chunk RX side
	public _chunkedData: {
		[id: number]: {
			data: Blob[];
			count: number;
			total: number;
		};
	} = {};

	private _dc: RTCDataChannel;
	private _encodingQueue = new EncodingQueue();

	get dataChannel(): RTCDataChannel {
		return this._dc;
	}

	get bufferSize(): number {
		return this._buffer.length;
	}

	constructor(peerId: string, provider: Peer, options: any) {
		super(peerId, provider, options);

		this.connectionId =
			this.options.connectionId ||
			DataConnection.ID_PREFIX + util.randomToken();

		this.label = this.options.label || this.connectionId;
		this.serialization = this.options.serialization || SerializationType.Binary;
		this.reliable = !!this.options.reliable;

		this._encodingQueue.on("done", (ab: ArrayBuffer) => {
			this._bufferedSend(ab);
		});

		this._encodingQueue.on("error", () => {
			logger.error(
				`DC#${this.connectionId}: Error occured in encoding from blob to arraybuffer, close DC`,
			);
			this.close();
		});

		this._negotiator = new Negotiator(this);

		this._negotiator.startConnection(
			this.options._payload || {
				originator: true,
			},
		);
	}

	/** Called by the Negotiator when the DataChannel is ready. */
	initialize(dc: RTCDataChannel): void {
		this._dc = dc;
		this._configureDataChannel();
	}

	private _configureDataChannel(): void {
		if (!util.supports.binaryBlob || util.supports.reliable) {
			this.dataChannel.binaryType = "arraybuffer";
		}

		this.dataChannel.onopen = () => {
			logger.log(`DC#${this.connectionId} dc connection success, util supports: `);
			logger.log(util.supports);

			this._open = true;
			this.emit("open");
		};

		this.dataChannel.onmessage = (e) => {
			logger.log(`DC#${this.connectionId} dc onmessage:`, e.data);
			this._handleDataMessage(e);
		};

		this.dataChannel.onclose = () => {
			logger.log(`DC#${this.connectionId} dc closed for:`, this.peerName);
			this.close();
		};
	}

	// Handles a DataChannel message.
	private _handleDataMessage(input: { data: Blob | ArrayBuffer | string; }): void {
		const { data, } = input;
		const datatype = data.constructor;

		const isBinarySerialization =
			this.serialization === SerializationType.Binary ||
			this.serialization === SerializationType.BinaryUTF8;

		let deserializedData: any = data;

		if (isBinarySerialization) {
			if (datatype === Blob) {
				// Datatype should never be blob
				util.blobToArrayBuffer(data as Blob, (ab) => {
					const unpackedData = util.unpack(ab);
					this.emit("data", unpackedData);
				});
				return;
			} else if (datatype === ArrayBuffer) {
				deserializedData = util.unpack(data as ArrayBuffer);
			} else if (datatype === String) {
				// String fallback for binary data for browsers that don't support binary yet
				const ab = util.binaryStringToArrayBuffer(data as string);
				deserializedData = util.unpack(ab);
			}
		} else if (this.serialization === SerializationType.JSON) {
			deserializedData = this.parse(data as string);
		}

		// Check if we've chunked--if so, piece things back together.
		// We're guaranteed that this isn't 0.
		if (deserializedData.__peerData) {
			this._handleChunk(deserializedData);
			return;
		}

		super.emit("data", deserializedData);
	}

	private _handleChunk(data: {
		__peerData: number;
		n: number;
		total: number;
		data: Blob;
	}): void {
		logger.log("Found chunked data", data, this._chunkedData);
		const id = data.__peerData;
		const chunkInfo = this._chunkedData[id] || {
			data: [],
			count: 0,
			total: data.total,
		};

		chunkInfo.data[data.n] = data.data;
		chunkInfo.count++;
		this._chunkedData[id] = chunkInfo;

		if (chunkInfo.total === chunkInfo.count) {
			// Clean up before making the recursive call to `_handleDataMessage`.
			delete this._chunkedData[id];

			// We've received all the chunks--time to construct the complete data.
			const data = new Blob(chunkInfo.data);
			this._handleDataMessage({ data });
		}
	}

	/**
	 * Exposed functionality for users.
	 */

	/** Allows user to close connection. */
	close(): void {
		this._buffer = [];
		// this._bufferSize = 0;
		this._chunkedData = {};

		if (this._negotiator) {
			this._negotiator.cleanup();
			this._negotiator = null;
		}

		if (this.peer) {
			this.peer._removeConnection(this);

			this.peer = null;
		}

		if (this.dataChannel) {
			this.dataChannel.onopen = null;
			this.dataChannel.onmessage = null;
			this.dataChannel.onclose = null;
			this._dc = null;
		}

		if (this._encodingQueue) {
			this._encodingQueue.destroy();
			this._encodingQueue.removeAllListeners();
			this._encodingQueue = null;
		}

		if (!this.open) {
			return;
		}

		this._open = false;

		super.emit("close");
	}

	/** Allows user to send data. */
	send(data: any, chunked?: boolean): void {
		if (!this.open) {
			super.emit(
				"error",
				new Error(
					"Connection is not open. You should listen for the `open` event before sending messages.",
				),
			);
			return;
		}

		if (this.serialization === SerializationType.JSON) {
			this._bufferedSend(this.stringify(data));
		}
		// Defer this check to happen on trySend
		else if (
			this.serialization === SerializationType.Binary ||
			this.serialization === SerializationType.BinaryUTF8
		) {
			const blob = util.pack(data);
			if (!chunked && blob.size > util.chunkedMTU) {
				this._sendChunks(blob);
				return;
			}

			if (!util.supports.binaryBlob) {
				// We only do this if we really need to (e.g. blobs are not supported),
				// because this conversion is costly.
				// Happens very often in chrome
				this._encodingQueue.enque(blob);
			} else {
				this._bufferedSend(blob);
			}
		} else {
			this._bufferedSend(data);
		}
	}

	private _bufferedSend(msg: string | ArrayBuffer | Blob): void {
		if (this._buffering || !this._trySend(msg)) {
			this._buffer.push(msg);
			// this._bufferSize = this._buffer.length;
		}
	}

	// Returns true if the send succeeds.
	private _trySend(msg: any): boolean {
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
			//TODO: also update here what the status is for a whole chunk being sent
			// Send an event for that
			logger.log(`DC#${this.connectionId}: Sending message ${msg}`);
			if (typeof msg != "string" && msg.meta != undefined) {
				logger.log(`DC#${this.connectionId}: In chunked object `);
			}
			this.dataChannel.send(msg);
		} catch (e) {
			logger.error(`DC#:${this.connectionId} Error when sending:`, e);
			this._buffering = true;

			this.close();

			return false;
		}

		return true;
	}

	// Try to send the first message in the buffer and removes it if successful
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
			// this._bufferSize = this._buffer.length;
			this._tryBuffer();
		}
	}

	private _sendChunks(blob: Blob): void {
		const blobs = util.chunk(blob);
		logger.log(`DC#${this.connectionId} Try to send ${blobs.length} chunks...`);

		for (let blob of blobs) {
			logger.log(`DC#${this.connectionId}: Enqueing new chunk to buffer ${blob}`);
			logger.log(blob);
			this.send(blob, true);
		}
	}
	private

	handleMessage(message: ServerMessage): void {
		const payload = message.payload;

		switch (message.type) {
			case ServerMessageType.Answer:
				this._negotiator.handleSDP(message.type, payload.sdp);
				break;
			case ServerMessageType.Candidate:
				this._negotiator.handleCandidate(payload.candidate);
				break;
			default:
				logger.warn(
					"Unrecognized message type:",
					message.type,
					"from peer:",
					this.peerName,
				);
				break;
		}
	}
}
