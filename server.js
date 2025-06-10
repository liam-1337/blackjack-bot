const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path'); // Added for path manipulation

const app = express();
const server = http.createServer(app);

// --- Static File Serving ---
// Serve static files from the 'dist' directory (client build)
// Assumes 'dist' is one level up from 'blackjack-server' directory
const clientDistPath = path.join(__dirname, '..', 'dist');
console.log(`Attempting to serve static files from: ${clientDistPath}`);
app.use(express.static(clientDistPath));
// Check if the path is resolved correctly, especially in different deployment environments.
// For example, by trying to access a known file:
// app.get('/test-static', (req, res) => res.send(`Static path resolved to: ${clientDistPath}`));


const io = new Server(server, {
  cors: {
    origin: "*", // For production, restrict this, e.g., "http://yourdomain.com" or specific ports
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const GameManager = require('./game-logic/GameManager.js');

const MAX_PLAYERS_PER_TABLE = 6;
let playersAtTable = {}; // Manages connected sockets and basic player data for seat assignment

const serverGameConfig = {
    numberOfDecks: 6,
    maxPlayers: MAX_PLAYERS_PER_TABLE
    // Other game rules can be added here or will use GameManager's defaults
};

// Callback functions for GameManager to interact with Socket.IO
function broadcastGameStateToTable(eventName, data) {
    io.emit(eventName, data);
    // console.log(`Broadcasting to table: ${eventName}`, data); // Uncomment for debug
}

function sendToSpecificPlayer(playerId, eventName, data) {
    const playerSocket = io.sockets.sockets.get(playerId);
    if (playerSocket) {
        playerSocket.emit(eventName, data);
        // console.log(`Sending to player ${playerId}: ${eventName}`, data); // Uncomment for debug
    } else {
        console.warn(`Attempted to send message to offline or non-existent player: ${playerId}`);
    }
}

const gameManager = new GameManager(
    serverGameConfig,
    broadcastGameStateToTable,
    sendToSpecificPlayer,
    broadcastGameStateToTable  // sendToAllPlayers uses broadcast for now
);

// --- Main Route ---
// Serves index.html from the dist folder for the root path
app.get('/', (req, res) => {
  const indexPath = path.join(clientDistPath, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
        console.error("Error sending index.html:", err);
        res.status(500).send("Error loading the game. Client files might be missing from 'dist' directory.");
    }
  });
});


io.on('connection', (socket) => {
  console.log('Attempting to connect user:', socket.id);

  if (Object.keys(playersAtTable).length >= MAX_PLAYERS_PER_TABLE) {
    console.log('Table is full. Disconnecting user:', socket.id);
    socket.emit('table_full', { message: 'Sorry, the table is currently full.' });
    setTimeout(() => socket.disconnect(true), 1000);
    return;
  }

  let assignedSeat = -1;
  const takenSeats = Object.values(playersAtTable).map(p => p.seat);
  for (let i = 0; i < MAX_PLAYERS_PER_TABLE; i++) {
    if (!takenSeats.includes(i)) {
      assignedSeat = i;
      break;
    }
  }

  if (assignedSeat === -1) {
      console.log('No seat found, though table not full. Disconnecting user:', socket.id);
      socket.emit('table_full', { message: 'Error finding an available seat.' });
      setTimeout(() => socket.disconnect(true), 1000);
      return;
  }

  const playerForTableList = {
    id: socket.id,
    nickname: 'Player_' + socket.id.substring(0, 4),
    seat: assignedSeat
  };
  playersAtTable[socket.id] = playerForTableList;

  const gamePlayer = gameManager.addPlayer({
      id: socket.id,
      nickname: playerForTableList.nickname,
      seat: playerForTableList.seat,
      socket: socket
  });

  console.log(`Player ${gamePlayer.nickname} (ID: ${gamePlayer.id}) joined table in seat ${gamePlayer.seat}. Players: ${Object.keys(playersAtTable).length}`);

  socket.emit('joined_table', {
    playerDetails: gamePlayer,
    allPlayers: Object.values(gameManager.players)
  });

  socket.broadcast.emit('player_joined', {
    newPlayer: gamePlayer,
    allPlayers: Object.values(gameManager.players)
  });

  // Game-related event listeners
  socket.on('place_bet', (data) => {
    if (gameManager && typeof data.betAmount === 'number') {
        console.log(`Server received 'place_bet' from ${socket.id} for amount ${data.betAmount}`);
        gameManager.handlePlayerBet(socket.id, data.betAmount);
    } else {
        console.warn(`Invalid 'place_bet' data from ${socket.id}:`, data);
        socket.emit('action_error', { message: 'Invalid bet data.' });
    }
  });

  socket.on('player_ready_start_game', () => {
      if (gameManager && gameManager.players[socket.id]) {
          gameManager.players[socket.id].isReadyForNextRound = true;
          console.log(`Player ${gameManager.players[socket.id].nickname} is ready.`);

          if (gameManager.gameState === 'WAITING_FOR_PLAYERS' || gameManager.gameState === 'ROUND_OVER') {
              gameManager.tryStartGame();
          }
      } else {
          console.warn(`Player ${socket.id} signaled ready but not found in GameManager.`);
      }
  });

  socket.on('player_action', (actionData) => {
    if (gameManager) {
        console.log(`Server received 'player_action' from ${socket.id}:`, actionData);
        gameManager.handlePlayerAction(socket.id, actionData);
    } else {
        console.warn(`GameManager not available for 'player_action' from ${socket.id}`);
        socket.emit('action_error', { message: 'Game not available. Please try reconnecting.' });
    }
  });

  socket.on('player_insurance_action', (data) => {
    if(gameManager) {
        console.log(`Server received 'player_insurance_action' from ${socket.id}: ${data.takesInsurance}`);
        gameManager.handlePlayerInsurance(socket.id, data.takesInsurance);
    } else {
        console.warn(`GameManager not available for 'player_insurance_action' from ${socket.id}`);
        socket.emit('action_error', { message: 'Game not available for insurance action.' });
    }
  });

  socket.on('disconnect', () => {
    const disconnectedPlayerInfo = playersAtTable[socket.id];
    if (disconnectedPlayerInfo) { // Use the info from playersAtTable for consistent nickname/seat on disconnect event
      console.log(`Player ${disconnectedPlayerInfo.nickname} (ID: ${socket.id}) left table from seat ${disconnectedPlayerInfo.seat}.`);
      gameManager.removePlayer(socket.id);
      delete playersAtTable[socket.id];

      io.emit('player_left', {
        playerId: socket.id,
        nickname: disconnectedPlayerInfo.nickname,
        seat: disconnectedPlayerInfo.seat,
        allPlayers: Object.values(gameManager.players)
      });
    } else {
      console.log('User disconnected (was not at table or already removed):', socket.id);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Blackjack server (including client hosting) listening on port ${PORT}`);
  console.log(`Client should be accessible at http://localhost:${PORT}`);
});
