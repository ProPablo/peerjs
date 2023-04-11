console.log("starting server");
// @ts-ignore
import * as WebSocket from 'ws';

const server = new WebSocket.Server({ port: 8080 });

server.on('connection', (socket: WebSocket) => {
  console.log('Client connected');

  socket.on('message', (message: string) => {
    console.log(`Received message: ${message}`);

    // Send a response message
    socket.send(`Server received: ${message}`);
  });

  socket.on('close', () => {
    console.log('Client disconnected');
  });
});