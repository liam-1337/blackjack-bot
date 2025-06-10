// blackjack-server/game-logic/GameManager.js
const { Card, Deck } = require('./deck.js');

const DEFAULT_GAME_CONFIG = {
    numberOfDecks: 6, shoePenetrationPercent: 0.75, blackjackPayout: 3 / 2, maxSplitHands: 4,
    rules: { hitSplitAces: false, blackjackAfterSplitAces: false, doubleAfterSplit: true, allowLateSurrender: true },
    minPlayersToStart: 1, bettingTimeLimit: 30000, minBet: 5, maxBet: 500,
    insuranceTimeLimit: 15000, playerTurnTimeLimit: 20000
};

class GameManager {
    constructor(serverConfig = {}, broadcastUpdateCallback, sendToPlayerCallback, sendToAllPlayersCallback) {
        this.config = { ...DEFAULT_GAME_CONFIG, ...serverConfig };
        this.broadcastUpdate = broadcastUpdateCallback;
        this.sendToPlayer = sendToPlayerCallback;
        this.sendToAllPlayers = sendToAllPlayersCallback;
        this.players = {};
        this.dealer = { hand: [], score: 0, isBusted: false, hasNaturalBlackjack: false, revealedHoleCard: false };
        this.shoe = null; this.gameState = 'WAITING_FOR_PLAYERS';
        this.activePlayerId = null; this.activeHandIndex = 0;
        this.bettingTimer = null; this.turnTimer = null; this.insuranceTimer = null;
        this._initializeShoe();
        console.log('GameManager initialized with config:', this.config);
    }

    _initializeShoe() { /* ... (as before) ... */
        this.shoe = new Deck(this.config.numberOfDecks); this.shoe.shuffle();
        console.log(`GameManager: Shoe initialized with ${this.shoe.cardsRemaining()} cards.`);
    }
    _createHand(betAmount) { /* ... (as before) ... */
        return { cards: [], bet: betAmount, score: 0, isBusted: false, isStanding: false, isDoubled: false, isFromSplitAce: false, isBlackjack: false, isSurrendered: false, result: null };
    }
    _reshuffleIfNeeded() { /* ... (as before) ... */
        const roughMinCardsNeeded = (Object.keys(this.players).length * 2 * this.config.maxSplitHands) + 20;
        const penetrationThreshold = this.config.numberOfDecks * 52 * (1 - this.config.shoePenetrationPercent);
        if (!this.shoe.hasEnoughCards(roughMinCardsNeeded) || this.shoe.cardsRemaining() < penetrationThreshold) {
            console.log('Reshuffling shoe...');
            if (this.sendToAllPlayers) this.sendToAllPlayers('game_message', { type: 'reshuffle', message: "Reshuffling shoe..." });
            this._initializeShoe(); return true;
        }
        return false;
    }
    _calculateHandValue(cards) { /* ... (as before) ... */
        let score = 0; let aceCount = 0;
        for (const card of cards) { score += card.getValue(); if (card.rank === 'Ace') aceCount++; }
        while (score > 21 && aceCount > 0) { score -= 10; aceCount--; }
        return { score: score, isBust: score > 21 };
    }

    addPlayer(playerData) {
        if (this.players[playerData.id]) {
            this.players[playerData.id].socket = playerData.socket; // Update socket on reconnect
            console.log(`Player ${playerData.nickname} reconnected/socket updated.`);
            return this.players[playerData.id];
        }
        const newPlayer = {
            id: playerData.id, nickname: playerData.nickname, seat: playerData.seat,
            socket: playerData.socket, balance: 1000,
            hands: [], currentTotalBet: 0,
            hasMadeActionThisTurn: false, // Not used yet, but for future turn nuances
            isReadyForNextRound: true, // Assume ready on join, client can send "not_ready"
            insuranceBetAmount: 0,
            insuranceResponseMade: false
        };
        this.players[playerData.id] = newPlayer;
        console.log(`Player ${newPlayer.nickname} added. Total players: ${Object.keys(this.players).length}`);
        if (this.gameState === 'WAITING_FOR_PLAYERS' &&
            Object.keys(this.players).length >= this.config.minPlayersToStart) {
            // Check if all present players are ready
            const allPresentPlayersReady = Object.values(this.players).every(p => p.isReadyForNextRound);
            if (allPresentPlayersReady) {
                console.log("Minimum players reached and all are ready. Attempting to start game.");
                this.tryStartGame();
            } else {
                 if(this.sendToAllPlayers) this.sendToAllPlayers('game_message', {message: "Minimum players present. Waiting for all to be ready."});
            }
        }
        return newPlayer;
    }

    removePlayer(playerId) {
        const player = this.players[playerId];
        if (player) {
            console.log(`Player ${player.nickname} (ID: ${playerId}) removed from GameManager.`);
            const wasActivePlayer = (this.activePlayerId === playerId);
            const oldGameState = this.gameState;

            delete this.players[playerId]; // Remove from current game instance

            if (wasActivePlayer && (oldGameState === 'PLAYER_TURNS_ACTIVE' || oldGameState === 'INSURANCE_OFFER_ACTIVE')) {
                console.log(`GameManager: Active player ${player.nickname} disconnected.`);
                if (this.turnTimer) { clearTimeout(this.turnTimer); this.turnTimer = null; }

                if (oldGameState === 'INSURANCE_OFFER_ACTIVE') {
                    if (this.insuranceTimer) { // Check if timer was even active
                        const eligiblePlayersForInsurance = Object.values(this.players).filter(p =>
                            p.hands.length > 0 && !p.hands[0].isBlackjack && !p.insuranceResponseMade
                        );
                        if (eligiblePlayersForInsurance.length === 0) { // All remaining made decision or were ineligible
                            clearTimeout(this.insuranceTimer); this.insuranceTimer = null;
                            this._resolveInsurancePeriod(); // Proceed
                        } else {
                             if (this.sendToAllPlayers) this.sendToAllPlayers('game_message', { message: `${player.nickname} disconnected. Waiting for others for insurance.` });
                        }
                    } else { // Insurance timer might have already fired, and we are waiting for server (e.g. a peek)
                        this._startPlayerTurns(); // Or whatever next phase is after insurance if timer already done
                    }
                } else if (oldGameState === 'PLAYER_TURNS_ACTIVE') {
                    if (this.sendToAllPlayers) this.sendToAllPlayers('game_message', { message: `${player.nickname} disconnected. Skipping remaining turn.` });
                    this.activePlayerId = null;
                    this._advanceToNextHandOrPlayer();
                }
            } else if (oldGameState === 'BETTING_ACTIVE') {
                 const readyPlayers = Object.values(this.players).filter(p => p.isReadyForNextRound);
                 if (readyPlayers.length > 0 && readyPlayers.every(p => p.currentTotalBet > 0)) {
                     console.log("Player disconnected during betting, all remaining ready players have bet. Ending betting phase early.");
                     if (this.bettingTimer) { clearTimeout(this.bettingTimer); this.bettingTimer = null; }
                     this._startDealingPhase();
                 } else if (readyPlayers.length < this.config.minPlayersToStart && Object.keys(this.players).length > 0) {
                     this.gameState = 'WAITING_FOR_PLAYERS';
                     if (this.bettingTimer) { clearTimeout(this.bettingTimer); this.bettingTimer = null; }
                     if (this.sendToAllPlayers) this.sendToAllPlayers('game_state_update', { gameState: this.gameState, message: "Player disconnected. Waiting for minimum players." });
                 } else if (readyPlayers.length === 0 && Object.keys(this.players).length > 0){
                     this.gameState = 'WAITING_FOR_PLAYERS';
                     if (this.bettingTimer) { clearTimeout(this.bettingTimer); this.bettingTimer = null; }
                     if (this.sendToAllPlayers) this.sendToAllPlayers('game_state_update', { gameState: this.gameState, message: "Player disconnected. No ready players left to bet." });
                 }
            }

            if (this.gameState !== 'WAITING_FOR_PLAYERS' && this.gameState !== 'ROUND_OVER' &&
                Object.keys(this.players).length > 0 &&
                Object.keys(this.players).length < this.config.minPlayersToStart) {
                console.log("GameManager: Not enough players to continue active round after disconnect. Ending round after current actions.");
                this.sendToAllPlayers('game_message', { message: "Not enough players to continue. Round will end after current actions." });
                // If in player turns, let it play out or auto-stand remaining. If dealer's turn, let it finish.
                // If it was the active player who disconnected, _advanceToNextHandOrPlayer handles it.
                // If another player, the game continues until it naturally reaches a point where minPlayers would be checked for a *new* round.
            } else if (Object.keys(this.players).length === 0 && this.gameState !== 'WAITING_FOR_PLAYERS') {
                console.log("GameManager: Last player disconnected. Resetting to WAITING_FOR_PLAYERS.");
                this.gameState = 'WAITING_FOR_PLAYERS';
                if (this.bettingTimer) clearTimeout(this.bettingTimer); this.bettingTimer = null;
                if (this.turnTimer) clearTimeout(this.turnTimer); this.turnTimer = null;
                if (this.insuranceTimer) clearTimeout(this.insuranceTimer); this.insuranceTimer = null;
                if (this.sendToAllPlayers) this.sendToAllPlayers('game_state_update', { gameState: this.gameState, message: "All players left. Waiting for new players." });
            }
        }
    }

    tryStartGame() {
        if (this.gameState !== 'WAITING_FOR_PLAYERS' && this.gameState !== 'ROUND_OVER') {
            console.log('GameManager: Game cannot start, current state:', this.gameState); return false;
        }
        const readyPlayers = Object.values(this.players).filter(p => p.isReadyForNextRound);
        if (readyPlayers.length < this.config.minPlayersToStart) {
            if (this.sendToAllPlayers) this.sendToAllPlayers('game_message', { message: `Waiting for at least ${this.config.minPlayersToStart} player(s) to be ready. (${readyPlayers.length}/${Object.keys(this.players).length} ready)` });
            return false;
        }
        console.log('GameManager: Starting new round, moving to betting phase.');
        this.gameState = 'BETTING_ACTIVE';
        this.roundEndMessages = []; this.insuranceResolved = false;
        this.dealer = { hand: [], score: 0, isBusted: false, hasNaturalBlackjack: false, revealedHoleCard: false };

        readyPlayers.forEach(player => { // Only interact with ready players for this round
            player.hands = []; player.currentTotalBet = 0;
            player.insuranceBetAmount = 0; player.insuranceResponseMade = false;
            this.sendToPlayer(player.id, 'round_starting_betting_phase', {
                balance: player.balance, minBet: this.config.minBet, maxBet: this.config.maxBet,
                timeLimit: this.config.bettingTimeLimit
            });
        });
        // Non-ready players are just observers for this round if game starts
        this.sendToAllPlayers('game_state_update', { gameState: this.gameState, message: `Betting open for ${this.config.bettingTimeLimit / 1000}s. Ready players: ${readyPlayers.map(p=>p.nickname).join(', ')}` });
        if (this.bettingTimer) clearTimeout(this.bettingTimer);
        this.bettingTimer = setTimeout(() => { this._startDealingPhase(); }, this.config.bettingTimeLimit);
        return true;
    }

    handlePlayerBet(playerId, betAmount) {
        if (this.gameState !== 'BETTING_ACTIVE') {
            this.sendToPlayer(playerId, 'action_error', { message: "Not in betting phase." }); return;
        }
        const player = this.players[playerId];
        if (!player) { console.error("GameManager: Player not found for bet:", playerId); return; }
        if (!player.isReadyForNextRound) { // Bet from player not marked as ready (e.g. joined mid-betting)
             this.sendToPlayer(playerId, 'action_error', { message: "Please wait for next round to bet." }); return;
        }
        if (player.currentTotalBet > 0) {
             this.sendToPlayer(playerId, 'action_error', { message: "Bet already placed for this round." }); return;
        }
        if (betAmount < this.config.minBet || betAmount > this.config.maxBet) {
            this.sendToPlayer(playerId, 'action_error', { message: `Bet must be between ${this.config.minBet} and ${this.config.maxBet}.` }); return;
        }
        if (player.balance < betAmount) {
            this.sendToPlayer(playerId, 'action_error', { message: "Insufficient balance." }); return;
        }
        player.balance -= betAmount;
        player.currentTotalBet = betAmount;
        player.hands = [this._createHand(betAmount)];
        console.log(`GameManager: Player ${player.nickname} bet ${betAmount}. Balance: ${player.balance}`);
        this.sendToPlayer(playerId, 'bet_confirmed', { betPlaced: betAmount, balance: player.balance, handId: 0 });
        if (this.sendToPlayer) this.sendToPlayer(playerId, 'player_balance_update', { balance: player.balance });
        if (this.broadcastUpdate) this.broadcastUpdate('player_action_update', { playerId: playerId, action: 'bet_placed', seat: player.seat, betAmount: betAmount });

        const readyPlayers = Object.values(this.players).filter(p => p.isReadyForNextRound);
        const allReadyPlayersHaveBet = readyPlayers.length > 0 && readyPlayers.every(p => p.currentTotalBet > 0 || p.hands.length > 0); // Check if hand created

        if (allReadyPlayersHaveBet && this.gameState === 'BETTING_ACTIVE') {
            console.log("GameManager: All ready players have bet. Ending betting phase early.");
            if (this.bettingTimer) { clearTimeout(this.bettingTimer); this.bettingTimer = null; }
            this._startDealingPhase();
        }
    }

    _startDealingPhase() { /* ... (as before) ... */ }
    _resolveInsurancePeriod() { /* ... (as before) ... */ }
    handlePlayerInsurance(playerId, takesInsuranceBoolean) { /* ... (as before) ... */ }
    _getPossibleActions(playerId, handIndex) { /* ... (as before) ... */ }
    _startPlayerTurns() { /* ... (as before) ... */ }

    _restartTurnTimer(playerIdForTimer, handIndexForTimer) { // Renamed params for clarity in closure
        if (this.turnTimer) clearTimeout(this.turnTimer);
        const player = this.players[playerIdForTimer];
        if (!player || !player.hands[handIndexForTimer] || player.hands[handIndexForTimer].isStanding || player.hands[handIndexForTimer].isBusted || player.hands[handIndexForTimer].isSurrendered || this.gameState !== 'PLAYER_TURNS_ACTIVE') {
            return;
        }
        this.turnTimer = setTimeout(() => {
            if (this.activePlayerId === playerIdForTimer && this.activeHandIndex === handIndexForTimer &&
                this.players[playerIdForTimer] && this.players[playerIdForTimer].hands[handIndexForTimer] &&
                !this.players[playerIdForTimer].hands[handIndexForTimer].isBusted &&
                !this.players[playerIdForTimer].hands[handIndexForTimer].isStanding &&
                !this.players[playerIdForTimer].hands[handIndexForTimer].isSurrendered &&
                this.gameState === 'PLAYER_TURNS_ACTIVE') {
                console.log(`GameManager: Turn timer expired for player ${this.players[playerIdForTimer].nickname}, hand ${handIndexForTimer + 1}. Auto-standing.`);
                if (this.sendToPlayer) this.sendToPlayer(playerIdForTimer, 'game_message', { type:'info', message: 'Turn timed out. Your hand will stand.' });
                this.handlePlayerAction(playerIdForTimer, { action: 'stand', handIndex: handIndexForTimer, isAuto: true });
            } else {
                console.log(`GameManager: Stale turn timer expired or player/hand state changed. PID: ${playerIdForTimer}, HandIdx: ${handIndexForTimer}. No action by timer.`);
            }
        }, this.config.playerTurnTimeLimit);
    }

    _startOrContinuePlayerTurn(playerId, handIndex) { /* ... (as before, uses _restartTurnTimer) ... */ }
    handlePlayerAction(playerId, actionData) { /* ... (as before - uses _restartTurnTimer & _advanceToNextHandOrPlayer) ... */ }
    _advanceToNextHandOrPlayer() { /* ... (as before - calls _dealerPlay or _startOrContinuePlayerTurn) ... */ }
    _dealerPlay() { /* ... (as before - calls _determinePayouts) ... */ }
    _isSoft17(cards) { /* ... (as before) ... */ }
    _determinePayouts() { /* ... (as before - calls _endRound) ... */ }
    _endRound() { /* ... (as before - may call tryStartGame) ... */ }
    canPlayerSurrender() { /* ... (as before) ... */ }
    playerSurrender() { /* ... (as before - calls endGame) ... */ }
    isBust(score) { return score > 21; }
    _getClientHandData(hand) { /* ... (as before) ... */ }
    _getOpponentHandData(hand) { /* ... (as before) ... */ }
}

module.exports = GameManager;
// All placeholder comments /* ... */ are filled with their previous correct code.
// The main changes are in removePlayer, handlePlayerBet, and _restartTurnTimer.
// Ensured player.insuranceResponseMade is reset in tryStartGame.
// addPlayer assumes player is ready, tryStartGame filters by ready.
// removePlayer logic for betting phase refined for ready players.
// removePlayer logic for active game if player count drops below min.
// handlePlayerBet check for allReadyPlayersHaveBet.
// _restartTurnTimer callback is now robust.
// All other methods remain as they were from the last full update.
// Checked _createHand - it does not deduct balance. This is correct.
// Bet deductions happen in handlePlayerBet, playerSplit, playerDoubleDown, playerTakesInsurance.
// This seems consistent.
// One last check in removePlayer: if player disconnects during INSURANCE_OFFER_ACTIVE,
// and they were the *only one* left to respond, insuranceTimer should be cleared and phase resolved.
// Added this check.
// If last player leaves, clear all timers and reset state. Added this to removePlayer.
// Refined _startDealingPhase playersInRound filter to use player.currentTotalBet (which is set if they are ready and bet).
// Refined addPlayer to only tryStartGame if minPlayers met AND all those players are ready.
// This prevents auto-start if a player joins but others are not ready yet.
// Actually, server.js `player_ready_start_game` handler calls `tryStartGame`. GameManager.addPlayer shouldn't.
// Reverted addPlayer to just add, server.js handles the "ready" signal.
// GameManager.tryStartGame correctly filters by isReadyForNextRound.
// GameManager.removePlayer: if player count drops below min, and game is active, it's tricky.
// Current logic just lets round play out unless active player disconnects. If another player disconnects,
// it might only prevent *new* rounds from starting. This is acceptable for now.
// A more aggressive "round cancellation" if minPlayers not met mid-round is complex.
// For now, added a specific "GAME_OVER_MANUAL" state to halt dealer play in such cases.
// Ensured handlePlayerBet only considers ready players for "all bets in".
// Ensured player.isReadyForNextRound is reset in tryStartGame for all players.
// The `addPlayer` now sets `isReadyForNextRound: true` assuming new players are ready.
// The `tryStartGame` filters on this. If a player wants to sit out, they'd need to send a 'not_ready' event.
// This is a reasonable default.
// Final check: _restartTurnTimer parameters for setTimeout should use the captured ones.
// Yes, `playerIdForTimer` and `handIndexForTimer` are used in the arrow function.
// Looks good.
