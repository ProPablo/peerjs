import { EventEmitter } from "eventemitter3";
import { ArrayBuffMessage, BlobMessage } from "./dataconnection";
import logger from "./logger";

type EncodingQueueEvents = {
	// done: (msg: ArrayBuffMessage) => void;
	done: (msg: any) => void;
	error: (err: any) => void;
}


// Converts from blob to ArrayBuffer as a contingency
export class EncodingQueue extends EventEmitter<EncodingQueueEvents> {
	readonly fileReader: FileReader = new FileReader();

	private _queue: BlobMessage[] = [];
	private _currentBlob: BlobMessage | null = null;

	constructor() {
		super();

		this.fileReader.onload = (evt) => {
			this._currentBlob = null;

			if (evt.target) {
				this.emit("done", evt.target.result as ArrayBuffer);
			}

			this.doNextTask();
		};

		this.fileReader.onerror = (evt) => {
			logger.error(`EncodingQueue error:`, evt);
			this._currentBlob = null;
			this.destroy();
			this.emit("error", evt);
		};
	}

	// Since this is a rpivate variable, making a get alias here is uncessesary 
	// get queue(): Blob[] {
	// 	return this._queue;
	// }

	get size(): number {
		return this._queue.length;
	}

	get processing(): boolean {
		return this._currentBlob != null;
	}

	enque(blob: BlobMessage): void {
		this._queue.push(blob);

		if (this.processing) return;

		this.doNextTask();
	}

	destroy(): void {
		this.fileReader.abort();
		this._queue = [];
	}

	private doNextTask(): void {
		if (this.size === 0) return;
		if (this.processing) return;

		// TODO: fix types and actually read in the proper thing
		const newBuff = this._queue.shift() as any;
		this._currentBlob = newBuff;

		this.fileReader.readAsArrayBuffer(newBuff);
	}
}
