import "./setup";
import { expect } from "chai";
import { Peer } from "../lib/peer";
import { Server } from "mock-socket";
import { createMockServer } from "./peer";
import { DataConnection } from "../lib/dataconnection";
import { readFile, appendFile} from 'fs/promises';


// https://stackoverflow.com/questions/8609289/convert-a-binary-nodejs-buffer-to-javascript-arraybuffer
function toArrayBuffer(buffer: Buffer) {
    const arrayBuffer = new ArrayBuffer(buffer.length);
    const view = new Uint8Array(arrayBuffer);
    for (let i = 0; i < buffer.length; ++i) {
        view[i] = buffer[i];
    }
    return arrayBuffer;
}

function toBuffer(arrayBuffer) {
  const buffer = Buffer.alloc(arrayBuffer.byteLength);
  const view = new Uint8Array(arrayBuffer);
  for (let i = 0; i < buffer.length; ++i) {
    buffer[i] = view[i];
  }
  return buffer;
}


const test_string = "Hey man";

// Keep in mind these tests will fail if typescript is not adhered to 
describe("Dataconnection: send data string", function () {
    let server: Server;
    let dc1: DataConnection;
    let dc2: DataConnection;
    before(function () {
        server = createMockServer();
    });

    describe("Initial connection", function () {

        it("Should connect the two dataconnections together (with correct settings)", function (done) {
            const peer1 = new Peer("1", { port: 8080, host: "localhost" });
            const peer2 = new Peer("2", { port: 8080, host: "localhost" });
            dc1 = peer1.connect("2");
            peer2.on("connection", (dc) => {
                dc2 = dc;
            });
            dc1.on("open", () => {
                // Run checks and cycle as complete
                done();
            });
        });

        it("Should recieve the right string", function (done) {
            dc1.on("data", (data) => {
                expect(data).to.be.eq(test_string);
                done();
            });
            dc2.send(test_string);
        });

        it("Should send data and notify for progress", async function (done) {
            // Should send return the sendID
            // Read sample file as binary array
            // https://copyprogramming.com/howto/reading-binary-data-in-node-js
            const binBuff = await readFile('./big_image.jpg');
            const arrBuff = toArrayBuffer(binBuff);
            
            debugger;

            const backToBuff = toBuffer(arrBuff);
            await appendFile('./saved_image.jpg', backToBuff);

            done();
            

            // TODO : implement in dc
            // const sendId = dc1.send(arrBuff);
            // dc1.on("progress", (prog) => {

            // });


        });
    })
    after(function () {
        server.stop();
    });
});