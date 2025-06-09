const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins for now (for easy local testing)
                 // For production, restrict this to your game client's URL
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const GameManager = require('./game-logic/GameManager.js');

const MAX_PLAYERS_PER_TABLE = 6; // This can also be part of serverGameConfig if preferred
let playersAtTable = {}; // Manages connected sockets and basic player data for seat assignment

const serverGameConfig = {
    numberOfDecks: 6,
    // other rules from DEFAULT_GAME_CONFIG in GameManager can be overridden here if needed
    maxPlayers: MAX_PLAYERS_PER_TABLE
};

// Callback functions for GameManager to interact with Socket.IO
function broadcastGameStateToTable(eventName, data) {
    // For a single table setup, io.emit sends to all connected clients.
    // If multiple tables: io.to(`table_${tableId}`).emit(eventName, data);
    io.emit(eventName, data);
    // console.log(`Broadcasting to table: ${eventName}`, data);
}

function sendToSpecificPlayer(playerId, eventName, data) {
    const playerSocket = io.sockets.sockets.get(playerId);
    if (playerSocket) {
        playerSocket.emit(eventName, data);
        // console.log(`Sending to player ${playerId}: ${eventName}`, data);
    } else {
        console.warn(`Attempted to send message to offline or non-existent player: ${playerId}`);
    }
}

// Instantiate the GameManager
const gameManager = new GameManager(
    serverGameConfig,
    broadcastGameStateToTable, // For general updates to all at table
    sendToSpecificPlayer,      // For messages to a single player
    broadcastGameStateToTable  // For messages to ALL players (io.emit)
);

// Basic route for testing server is up
app.get('/', (req, res) => {
  res.send('Blackjack server is running!');
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

  const playerForTableList = { // Data for server.js's own tracking of connected sockets/seats
    id: socket.id,
    nickname: 'Player_' + socket.id.substring(0, 4),
    seat: assignedSeat
  };
  playersAtTable[socket.id] = playerForTableList;

  // Add player to the GameManager
  const gamePlayer = gameManager.addPlayer({
      id: socket.id,
      nickname: playerForTableList.nickname,
      seat: playerForTableList.seat,
      socket: socket // Pass the actual socket object to GameManager
  });

  console.log(`Player ${gamePlayer.nickname} (ID: ${gamePlayer.id}) joined table in seat ${gamePlayer.seat}. Players: ${Object.keys(playersAtTable).length}`);

  socket.emit('joined_table', {
    playerDetails: gamePlayer, // Send full gamePlayer object from GameManager
    allPlayers: Object.values(gameManager.players) // Send players from GameManager
  });

  socket.broadcast.emit('player_joined', {
    newPlayer: gamePlayer,
    allPlayers: Object.values(gameManager.players)
  });

  // Listen for player actions
  socket.on('place_bet', (data) => {
    if (gameManager && typeof data.betAmount === 'number') {
        console.log(`Server received 'place_bet' from ${socket.id} for amount ${data.betAmount}`);
        gameManager.handlePlayerBet(socket.id, data.betAmount);
    } else {
        console.warn(`Invalid 'place_bet' data from ${socket.id}:`, data);
        // socket.emit('action_error', { message: 'Invalid bet data.' }); // Optional error feedback
    }
  });

  socket.on('player_ready_start_game', () => {
      if (gameManager && gameManager.players[socket.id]) {
          gameManager.players[socket.id].isReadyForNextRound = true;
          console.log(`Player ${gameManager.players[socket.id].nickname} is ready.`);

          if (gameManager.gameState === 'WAITING_FOR_PLAYERS' || gameManager.gameState === 'ROUND_OVER') {
              const canStart = gameManager.tryStartGame();
              // GameManager.tryStartGame already sends a message if not enough players
          }
      }
  });

  socket.on('disconnect', () => {
    const disconnectedPlayer = playersAtTable[socket.id]; // Get basic info for logging
    if (disconnectedPlayer) {
      console.log(`Player ${disconnectedPlayer.nickname} (ID: ${socket.id}) left table from seat ${disconnectedPlayer.seat}. Players: ${Object.keys(playersAtTable).length -1}`);
      gameManager.removePlayer(socket.id); // Remove from GameManager
      delete playersAtTable[socket.id]; // Remove from server.js's list

      io.emit('player_left', {
        playerId: socket.id,
        nickname: disconnectedPlayer.nickname, // Use info from playersAtTable before delete
        seat: disconnectedPlayer.seat,
        allPlayers: Object.values(gameManager.players) // Send updated list from GameManager
      });
    } else {
      console.log('User disconnected (was not at table or already removed):', socket.id);
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
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
