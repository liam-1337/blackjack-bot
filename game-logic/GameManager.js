// blackjack-server/game-logic/GameManager.js
const { Card, Deck } = require('./deck.js');

const DEFAULT_GAME_CONFIG = {
    numberOfDecks: 6,
    shoePenetrationPercent: 0.75,
    blackjackPayout: 3 / 2,
    maxSplitHands: 4,
    rules: {
        hitSplitAces: false,
        blackjackAfterSplitAces: false,
        doubleAfterSplit: true,
        allowLateSurrender: true
    },
    minPlayersToStart: 1,
    bettingTimeLimit: 30000,
    minBet: 5,
    maxBet: 500,
    insuranceTimeLimit: 15000,
    playerTurnTimeLimit: 20000
};

class GameManager {
    constructor(serverConfig = {}, broadcastUpdateCallback, sendToPlayerCallback, sendToAllPlayersCallback) {
        this.config = { ...DEFAULT_GAME_CONFIG, ...serverConfig };
        this.broadcastUpdate = broadcastUpdateCallback;
        this.sendToPlayer = sendToPlayerCallback;
        this.sendToAllPlayers = sendToAllPlayersCallback;

        this.players = {};
        this.dealer = { hand: [], score: 0, isBusted: false, hasNaturalBlackjack: false, revealedHoleCard: false };

        this.shoe = null;
        this.gameState = 'WAITING_FOR_PLAYERS';
        this.activePlayerId = null;
        this.activeHandIndex = 0;

        this.bettingTimer = null;
        this.turnTimer = null;
        this.insuranceTimer = null;

        this._initializeShoe();
        console.log('GameManager initialized with config:', this.config);
    }

    _initializeShoe() {
        this.shoe = new Deck(this.config.numberOfDecks);
        this.shoe.shuffle();
        console.log(`GameManager: Shoe initialized with ${this.shoe.cardsRemaining()} cards.`);
    }

    _createHand(betAmount) {
        return {
            cards: [], bet: betAmount, score: 0,
            isBusted: false, isStanding: false, isDoubled: false,
            isFromSplitAce: false, isBlackjack: false, isSurrendered: false,
            result: null
        };
    }

    _reshuffleIfNeeded() {
        const roughMinCardsNeeded = (Object.keys(this.players).length * 2 * this.config.maxSplitHands) + 20; // Increased buffer
        const penetrationThreshold = this.config.numberOfDecks * 52 * (1 - this.config.shoePenetrationPercent);

        if (!this.shoe.hasEnoughCards(roughMinCardsNeeded) || this.shoe.cardsRemaining() < penetrationThreshold) {
            console.log('Reshuffling shoe...');
            if (this.sendToAllPlayers) {
                this.sendToAllPlayers('game_message', { type: 'reshuffle', message: "Reshuffling shoe..." });
            }
            this._initializeShoe();
            return true;
        }
        return false;
    }

    _calculateHandValue(cards) {
        let score = 0; let aceCount = 0;
        for (const card of cards) {
            score += card.getValue();
            if (card.rank === 'Ace') aceCount++;
        }
        while (score > 21 && aceCount > 0) { score -= 10; aceCount--; }
        return { score: score, isBust: score > 21 };
    }

    addPlayer(playerData) { /* ... (as before, no changes in this step) ... */
        if (this.players[playerData.id]) {
            console.warn(`Player ${playerData.id} already in game. Updating socket.`);
            this.players[playerData.id].socket = playerData.socket;
            return this.players[playerData.id];
        }
        const newPlayer = {
            id: playerData.id, nickname: playerData.nickname, seat: playerData.seat,
            socket: playerData.socket, balance: 1000,
            hands: [], currentTotalBet: 0,
            hasMadeActionThisTurn: false, isReadyForNextRound: false
        };
        this.players[playerData.id] = newPlayer;
        console.log(`Player ${newPlayer.nickname} (ID: ${newPlayer.id}) added to GameManager in seat ${newPlayer.seat}.`);
        if (this.gameState === 'WAITING_FOR_PLAYERS' &&
            Object.keys(this.players).length >= this.config.minPlayersToStart) {
            console.log("Minimum players reached. Attempting to start game.");
            this.tryStartGame();
        }
        return newPlayer;
    }
    removePlayer(playerId) { /* ... (as before, no changes in this step) ... */
        if (this.players[playerId]) {
            console.log(`Player ${this.players[playerId].nickname} (ID: ${playerId}) removed from GameManager.`);
            delete this.players[playerId];
        }
    }

    tryStartGame() { /* ... (as before) ... */
        if (this.gameState !== 'WAITING_FOR_PLAYERS' && this.gameState !== 'ROUND_OVER') {
            console.log('GameManager: Game cannot start, current state:', this.gameState);
            return false;
        }
        if (Object.keys(this.players).length < this.config.minPlayersToStart) {
            console.log('GameManager: Not enough players to start.');
            this.sendToAllPlayers('game_message', { message: `Waiting for at least ${this.config.minPlayersToStart} player(s) to start.` });
            return false;
        }
        console.log('GameManager: Starting new round, moving to betting phase.');
        this.gameState = 'BETTING_ACTIVE';
        this.dealer = { hand: [], score: 0, isBusted: false, hasNaturalBlackjack: false, revealedHoleCard: false };
        Object.values(this.players).forEach(player => {
            player.hands = []; player.currentTotalBet = 0;
            player.hasMadeActionThisTurn = false; player.isReadyForNextRound = false;
            player.insuranceBetAmount = 0; // Reset insurance bet amount for player
            this.sendToPlayer(player.id, 'round_starting_betting_phase', {
                balance: player.balance, minBet: this.config.minBet, maxBet: this.config.maxBet
            });
        });
        this.sendToAllPlayers('game_state_update', { gameState: this.gameState, message: `Betting open for ${this.config.bettingTimeLimit / 1000}s` });
        if (this.bettingTimer) clearTimeout(this.bettingTimer);
        this.bettingTimer = setTimeout(() => { this._startDealingPhase(); }, this.config.bettingTimeLimit);
        return true;
    }
    handlePlayerBet(playerId, betAmount) { /* ... (as before) ... */
        if (this.gameState !== 'BETTING_ACTIVE') {
            this.sendToPlayer(playerId, 'action_error', { message: "Not in betting phase." }); return;
        }
        const player = this.players[playerId];
        if (!player) { console.error("GameManager: Player not found for bet:", playerId); return; }
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
        this.sendToPlayer(playerId, 'bet_confirmed', {
            betPlaced: betAmount, balance: player.balance, handId: 0
        });
        if (this.broadcastUpdate) {
            this.broadcastUpdate('player_action_update', {
                playerId: playerId, action: 'bet_placed', seat: player.seat, betAmount: betAmount
            });
        }
         if (this.sendToPlayer) this.sendToPlayer(playerId, 'player_balance_update', { balance: player.balance });

    }
    _startDealingPhase() { /* ... (Modified as per subtask description) ... */
        if (this.gameState !== 'BETTING_ACTIVE') return;
        console.log('GameManager: Betting closed. Dealing cards.');
        this.gameState = 'DEALING_CARDS';
        if (this.bettingTimer) clearTimeout(this.bettingTimer);
        this.sendToAllPlayers('game_state_update', { gameState: this.gameState, message: "Dealing cards..." });
        this._reshuffleIfNeeded();
        const playersInRound = Object.values(this.players).filter(p => p.hands.length > 0 && p.hands[0].bet > 0);
        if (playersInRound.length === 0) {
            console.log("GameManager: No players placed bets. Round aborted.");
            this.gameState = 'ROUND_OVER';
            this.sendToAllPlayers('game_state_update', { gameState: this.gameState, message: "No bets placed. Round over." });
            setTimeout(() => this.tryStartGame(), 5000);
            return;
        }
        for (let i = 0; i < 2; i++) {
            playersInRound.forEach(player => {
                if (player.hands[0] && this.shoe.hasEnoughCards(1)) {
                    player.hands[0].cards.push(this.shoe.dealCard());
                } else if (!this.shoe.hasEnoughCards(1)) { this._reshuffleIfNeeded(); player.hands[0].cards.push(this.shoe.dealCard());}
            });
            if (this.shoe.hasEnoughCards(1)) { this.dealer.hand.push(this.shoe.dealCard());}
            else { this._reshuffleIfNeeded(); this.dealer.hand.push(this.shoe.dealCard());}
        }
        const dealerHandValue = this._calculateHandValue(this.dealer.hand);
        this.dealer.score = dealerHandValue.score;
        this.dealer.hasNaturalBlackjack = (this.dealer.hand.length === 2 && this.dealer.score === 21);
        this.dealer.revealedHoleCard = false;
        playersInRound.forEach(player => {
            const hand = player.hands[0];
            const handValue = this._calculateHandValue(hand.cards);
            hand.score = handValue.score; hand.isBusted = handValue.isBust;
            hand.isBlackjack = (hand.cards.length === 2 && hand.score === 21 && (!hand.isFromSplitAce || (hand.isFromSplitAce && this.config.rules.blackjackAfterSplitAces)));
            const ownHandDataForClient = { cards: hand.cards.map(c => c.toPlainObject()), score: hand.score, isBlackjack: hand.isBlackjack, bet: hand.bet };
            const otherPlayersDataForClient = playersInRound.filter(p => p.id !== player.id).map(p => ({ seat: p.seat, nickname: p.nickname, bet: p.hands[0].bet }));
            const dealerUpCardForClient = this.dealer.hand.length > 0 ? this.dealer.hand[0].toPlainObject() : null;
            this.sendToPlayer(player.id, 'initial_deal_complete', {
                playerSeat: player.seat, hands: [ownHandDataForClient],
                dealerUpCard: dealerUpCardForClient, otherPlayers: otherPlayersDataForClient,
                canTakeInsurance: this.dealer.hand.length > 0 && this.dealer.hand[0].rank === 'Ace' && !hand.isBlackjack
            });
        });
        console.log("GameManager: Initial deal complete. Checking for Blackjacks or offering insurance.");
        const dealerShowsAce = this.dealer.hand.length > 0 && this.dealer.hand[0].rank === 'Ace';
        const anyPlayerEligibleForInsurance = playersInRound.some(p => !p.hands[0].isBlackjack);
        if (dealerShowsAce && anyPlayerEligibleForInsurance && !this.dealer.hasNaturalBlackjack) {
            this.gameState = 'INSURANCE_OFFER_ACTIVE';
            this.sendToAllPlayers('insurance_offered', { bettingTimeLimit: this.config.insuranceTimeLimit });
            playersInRound.forEach(player => {
                if (!player.hands[0].isBlackjack) { // Only offer to players without BJ
                    player.insuranceResponseMade = false; // Reset flag for this round
                    this.sendToPlayer(player.id, 'prompt_insurance', { cost: player.hands[0].bet / 2 });
                } else { player.insuranceResponseMade = true; } // Player with BJ doesn't participate in insurance decision
            });
            console.log(`GameManager: Insurance offered. Waiting ${this.config.insuranceTimeLimit / 1000}s for responses.`);
            if (this.insuranceTimer) clearTimeout(this.insuranceTimer);
            this.insuranceTimer = setTimeout(() => { this._resolveInsurancePeriod(); }, this.config.insuranceTimeLimit);
        } else {
            if (!this.dealer.hasNaturalBlackjack && !playersInRound.every(p => p.hands[0].isBlackjack) ) { // If dealer no BJ and not all players have BJ
                 console.log("GameManager: No insurance offered or not applicable. Proceeding to player turns.");
                 this._startPlayerTurns();
            } else {
                console.log("GameManager: Game concluded by Blackjacks or no eligible players for insurance/turns.");
                // If dealer had natural, game ends for non-BJ players.
                // If all players had BJ, game also ends.
                // This path means _determinePayouts and _endRound will be called by previous logic if game is over.
                if (!this.isGameOver) { // If game not already ended by BJ logic in startGame
                    this._dealerPlay(); // Or directly to payouts if no player action possible
                }
            }
        }
    }
    _resolveInsurancePeriod() { /* ... (as before) ... */
        if (this.gameState !== 'INSURANCE_OFFER_ACTIVE') return;
        console.log("GameManager: Insurance period ended.");
        if (this.insuranceTimer) clearTimeout(this.insuranceTimer);
        this._startPlayerTurns();
    }
    handlePlayerInsurance(playerId, takesInsuranceBoolean) { /* ... (as before, ensure player.insuranceBetAmount is set on player) ... */
        if (this.gameState !== 'INSURANCE_OFFER_ACTIVE') {
            this.sendToPlayer(playerId, 'action_error', { message: "Not in insurance phase." }); return;
        }
        const player = this.players[playerId];
        if (!player) { console.error("GameManager: Player not found for insurance action:", playerId); return; }
        if (player.insuranceResponseMade) {
             this.sendToPlayer(playerId, 'action_error', { message: "Insurance decision already made." }); return;
        }
        player.insuranceResponseMade = true;
        if (takesInsuranceBoolean) {
            const hand = player.hands[0];
            if (!hand) { this.sendToPlayer(playerId, 'action_error', { message: "No hand to place insurance against." }); return; }
            const insuranceCost = hand.bet / 2;
            if (player.balance < insuranceCost) {
                this.sendToPlayer(playerId, 'action_error', { message: "Insufficient balance for insurance." });
                player.insuranceBetAmount = 0; // Effectively declined
            } else {
                player.balance -= insuranceCost; player.insuranceBetAmount = insuranceCost;
                console.log(`GameManager: Player ${player.nickname} took insurance for ${insuranceCost}. Balance: ${player.balance}`);
                this.sendToPlayer(playerId, 'insurance_accepted', { insuranceBet: player.insuranceBetAmount, balance: player.balance });
                if(this.sendToPlayer) this.sendToPlayer(playerId, 'player_balance_update', { balance: player.balance });
            }
        } else {
            player.insuranceBetAmount = 0;
            console.log(`GameManager: Player ${player.nickname} declined insurance.`);
            this.sendToPlayer(playerId, 'insurance_declined', {});
        }
        const playersInRound = Object.values(this.players).filter(p => p.hands.length > 0 && p.hands[0].bet > 0 && !p.hands[0].isBlackjack);
        const allResponded = playersInRound.every(p => p.insuranceResponseMade || p.hands[0].isBlackjack); // Players with BJ don't respond
        if (allResponded) {
            if (this.insuranceTimer) clearTimeout(this.insuranceTimer);
            this._resolveInsurancePeriod();
        }
    }
    _getPossibleActions(playerId, handIndex) { /* ... (as before) ... */
        const player = this.players[playerId];
        if (!player || !player.hands[handIndex]) return [];
        const hand = player.hands[handIndex]; const actions = [];
        if (hand.isBusted || hand.isStanding || hand.isSurrendered) return [];
        actions.push('stand'); // Stand is always an option if hand is active
        if (!hand.isFromSplitAce || (hand.isFromSplitAce && this.config.rules.hitSplitAces)) { // Can hit unless split Ace and rule forbids
            actions.push('hit');
        }
        if (hand.cards.length === 2 && !hand.isDoubled) {
            let canDouble = (this.config.rules.doubleAfterSplit || player.hands.length === 1);
            if (hand.isFromSplitAce && !this.config.rules.hitSplitAces) canDouble = false; // Usually no double if no hit on split Ace
            if (canDouble && player.balance >= hand.bet) actions.push('double');
        }
        if (hand.cards.length === 2 && player.hands.length < this.config.maxSplitHands) {
            if (hand.cards[0].rank === hand.cards[1].rank) {
                 if (player.balance >= hand.bet) actions.push('split');
            }
        }
        if (this.config.rules.allowLateSurrender && player.hands.length === 1 && hand.cards.length === 2 && handIndex === 0) {
            actions.push('surrender');
        }
        return actions;
    }
    _startPlayerTurns() { /* ... (as before) ... */
        if (this.gameState === 'INSURANCE_OFFER_ACTIVE') {
             console.log("Insurance phase ended, proceeding to player turns.");
        }
        this.gameState = 'PLAYER_TURNS_ACTIVE';
        this.sendToAllPlayers('game_state_update', { gameState: this.gameState, message: "Player turns starting."});
        const activePlayers = Object.values(this.players).filter(p => p.hands.length > 0 && p.hands.some(h => h.bet > 0 && !h.isBusted && !h.isStanding && !h.isSurrendered)).sort((a, b) => a.seat - b.seat);
        if (activePlayers.length === 0) {
            console.log("GameManager: No players eligible for turns. Proceeding to dealer.");
            this._dealerPlay();
            return;
        }
        this.activePlayerId = activePlayers[0].id;
        this.activeHandIndex = activePlayers[0].hands.findIndex(h => h.bet > 0 && !h.isBusted && !h.isStanding && !h.isSurrendered);
        if (this.activeHandIndex === -1) { // Should not happen if activePlayers is not empty
             console.error("Error: No playable hand found for supposedly active player."); this._dealerPlay(); return;
        }
        this._startOrContinuePlayerTurn(this.activePlayerId, this.activeHandIndex);
    }
    handlePlayerAction(playerId, actionData) { /* ... (as before, with full logic from prompt) ... */
        if (this.gameState !== 'PLAYER_TURNS_ACTIVE' || playerId !== this.activePlayerId ||
            (actionData.handIndex !== undefined && actionData.handIndex !== this.activeHandIndex) ) {
            this.sendToPlayer(playerId, 'action_error', { message: "Not your turn or invalid hand index." }); return;
        }
        const player = this.players[playerId];
        const hand = player.hands[this.activeHandIndex];
        if (!hand || hand.isBusted || hand.isStanding || hand.isSurrendered) {
            this.sendToPlayer(playerId, 'action_error', { message: "Current hand is already resolved."}); return;
        }
        const possibleActions = this._getPossibleActions(playerId, this.activeHandIndex);
        if (!possibleActions.includes(actionData.action)) {
            this.sendToPlayer(playerId, 'action_error', { message: `Action ${actionData.action} not allowed for this hand.` });
            this._restartTurnTimer(playerId, this.activeHandIndex); return;
        }
        if (this.turnTimer) clearTimeout(this.turnTimer);
        player.hasMadeActionThisTurn = true;
        console.log(`GameManager: Player ${player.nickname} action: ${actionData.action} on hand ${this.activeHandIndex + 1}`);
        let broadcastData = { playerId, seat: player.seat, action: actionData.action, handIndex: this.activeHandIndex };

        switch (actionData.action) {
            case 'hit':
                if (!this.shoe.hasEnoughCards(1)) this._reshuffleIfNeeded();
                const newCard = this.shoe.dealCard();
                if (newCard) {
                    hand.cards.push(newCard);
                    const value = this._calculateHandValue(hand.cards); hand.score = value.score; hand.isBusted = value.isBust;
                    broadcastData.newCard = newCard.toPlainObject(); broadcastData.updatedHand = this._getOpponentHandData(hand);
                    this.sendToPlayer(playerId, 'action_result', { action: 'hit', handIndex: this.activeHandIndex, newCard: newCard.toPlainObject(), updatedHand: this._getClientHandData(hand) });
                    this.broadcastUpdate('player_action_taken', broadcastData);
                    if (hand.isBusted) {
                        this.sendToPlayer(playerId, 'hand_result', { handIndex: this.activeHandIndex, result: 'bust', message: 'Your hand busted!' });
                        this._advanceToNextHandOrPlayer();
                    } else { this._startOrContinuePlayerTurn(playerId, this.activeHandIndex); }
                } else { this._advanceToNextHandOrPlayer(); }
                break;
            case 'stand':
                hand.isStanding = true;
                broadcastData.updatedHand = this._getOpponentHandData(hand);
                this.sendToPlayer(playerId, 'action_result', { action: 'stand', handIndex: this.activeHandIndex, updatedHand: this._getClientHandData(hand) });
                this.broadcastUpdate('player_action_taken', broadcastData);
                this._advanceToNextHandOrPlayer();
                break;
            case 'double':
                const additionalBet = hand.bet;
                if (player.balance < additionalBet) { this.sendToPlayer(playerId, 'action_error', { message: "Insufficient balance to double."}); this._restartTurnTimer(playerId, this.activeHandIndex); return; }
                player.balance -= additionalBet; player.currentTotalBet += additionalBet; hand.bet *= 2; hand.isDoubled = true;
                if(this.uiUpdaters.updatePlayerBalance) this.uiUpdaters.updatePlayerBalance(player.balance);
                this.sendToAllPlayers('table_bet_updated', { playerId: playerId, seat: player.seat, newHandBet: hand.bet, newTotalPlayerBet: player.currentTotalBet });

                if (!this.shoe.hasEnoughCards(1)) this._reshuffleIfNeeded();
                const doubledCard = this.shoe.dealCard();
                if (doubledCard) {
                    hand.cards.push(doubledCard);
                    const value = this._calculateHandValue(hand.cards); hand.score = value.score; hand.isBusted = value.isBust;
                    hand.isStanding = true;
                    broadcastData.newCard = doubledCard.toPlainObject(); broadcastData.updatedHand = this._getOpponentHandData(hand); broadcastData.newTotalBetForHand = hand.bet;
                    this.sendToPlayer(playerId, 'action_result', { action: 'double', handIndex: this.activeHandIndex, newCard: doubledCard.toPlainObject(), updatedHand: this._getClientHandData(hand), newBalance: player.balance });
                    this.broadcastUpdate('player_action_taken', broadcastData);
                    if (hand.isBusted) { this.sendToPlayer(playerId, 'hand_result', { handIndex: this.activeHandIndex, result: 'bust', message: 'Your hand busted after doubling!' }); }
                } else { /* Error handling */ }
                this._advanceToNextHandOrPlayer();
                break;
            case 'split':
                const splitBet = hand.bet;
                if (player.balance < splitBet) { this.sendToPlayer(playerId, 'action_error', { message: "Insufficient balance to split."}); this._restartTurnTimer(playerId, this.activeHandIndex); return; }
                player.balance -= splitBet; player.currentTotalBet += splitBet; // currentTotalBet tracks sum of player's bets on table
                if(this.uiUpdaters.updatePlayerBalance) this.uiUpdaters.updatePlayerBalance(player.balance);

                const originalHand = player.hands[this.activeHandIndex];
                const cardToMove = originalHand.cards.pop();
                const newHand = this._createHand(splitBet); // Creates hand with bet, does NOT deduct from balance
                newHand.cards.push(cardToMove);

                const wasAceSplit = (originalHand.cards[0].rank === 'Ace');
                newHand.isFromSplitAce = wasAceSplit; originalHand.isFromSplitAce = wasAceSplit;

                if (!this.shoe.hasEnoughCards(2)) this._reshuffleIfNeeded();
                originalHand.cards.push(this.shoe.dealCard());
                if (!this.shoe.hasEnoughCards(1)) this._reshuffleIfNeeded();
                newHand.cards.push(this.shoe.dealCard());

                originalHand.score = this._calculateHandValue(originalHand.cards).score;
                originalHand.isBlackjack = (originalHand.score === 21 && originalHand.cards.length === 2 && !(wasAceSplit && !this.config.rules.blackjackAfterSplitAces));
                newHand.score = this._calculateHandValue(newHand.cards).score;
                newHand.isBlackjack = (newHand.score === 21 && newHand.cards.length === 2 && !(wasAceSplit && !this.config.rules.blackjackAfterSplitAces));

                player.hands.splice(this.activeHandIndex + 1, 0, newHand);
                this.sendToAllPlayers('table_bet_updated', { playerId: playerId, seat: player.seat, newTotalPlayerBet: player.currentTotalBet });

                broadcastData.numHands = player.hands.length;
                this.sendToPlayer(playerId, 'split_result', { originalHand: this._getClientHandData(originalHand), newHand: this._getClientHandData(newHand), handIndex: this.activeHandIndex, newHandIndex: this.activeHandIndex + 1, newBalance: player.balance });
                this.broadcastUpdate('player_action_taken', broadcastData);
                if (wasAceSplit && !this.config.rules.hitSplitAces) {
                    originalHand.isStanding = true; newHand.isStanding = true;
                }
                this._startOrContinuePlayerTurn(playerId, this.activeHandIndex);
                break;
            case 'surrender':
                hand.isSurrendered = true; hand.isStanding = true;
                broadcastData.message = "Player surrendered.";
                this.sendToPlayer(playerId, 'action_result', { action: 'surrender', handIndex: this.activeHandIndex, updatedHand: this._getClientHandData(hand) });
                this.broadcastUpdate('player_action_taken', broadcastData);
                this._advanceToNextHandOrPlayer();
                break;
            default:
                this.sendToPlayer(playerId, 'action_error', { message: "Unknown action." });
                this._restartTurnTimer(playerId, this.activeHandIndex);
                return;
        }
    }
    _advanceToNextHandOrPlayer() { /* ... (as before) ... */
        const currentPlayer = this.players[this.activePlayerId];
        if (!currentPlayer) { console.error("Current player not found in _advanceToNextHandOrPlayer"); this.dealerPlay(); return;}
        this.activeHandIndex++;
        while (this.activeHandIndex < currentPlayer.hands.length &&
               (currentPlayer.hands[this.activeHandIndex].isBusted || currentPlayer.hands[this.activeHandIndex].isStanding || currentPlayer.hands[this.activeHandIndex].isSurrendered )) {
            this.activeHandIndex++;
        }
        if (this.activeHandIndex < currentPlayer.hands.length) {
            this.uiUpdaters.displayMessage(`Playing hand ${this.activeHandIndex + 1} for ${currentPlayer.nickname}.`); // This message is for server console
            this._startOrContinuePlayerTurn(this.activePlayerId, this.activeHandIndex);
        } else {
            let nextPlayer = null;
            let currentSeat = currentPlayer.seat;
            const sortedPlayers = Object.values(this.players).sort((a,b) => a.seat - b.seat);
            let currentPlayerSortedIndex = sortedPlayers.findIndex(p => p.id === this.activePlayerId);

            for (let i = 1; i < sortedPlayers.length; i++) {
                let nextSortedPlayerIndex = (currentPlayerSortedIndex + i) % sortedPlayers.length;
                let potentialNextPlayer = sortedPlayers[nextSortedPlayerIndex];
                if (potentialNextPlayer.hands.some(h => h.bet > 0 && !h.isBusted && !h.isStanding && !h.isSurrendered)) {
                    nextPlayer = potentialNextPlayer;
                    break;
                }
            }
            if (nextPlayer) {
                this.activePlayerId = nextPlayer.id;
                this.activeHandIndex = nextPlayer.hands.findIndex(h => h.bet > 0 && !h.isBusted && !h.isStanding && !h.isSurrendered);
                // this.uiUpdaters.displayMessage(`Next player: ${nextPlayer.nickname}, Hand ${this.activeHandIndex + 1}.`); // Server console
                this._startOrContinuePlayerTurn(this.activePlayerId, this.activeHandIndex);
            } else {
                this.isPlayerTurn = false;
                if (this.sendToAllPlayers) this.sendToAllPlayers('game_message', {type: 'status', message: "All players done. Dealer's turn."});
                this._dealerPlay();
            }
        }
        this.updatePlayerUI();
    }
    _startOrContinuePlayerTurn(playerId, handIndex) { /* ... (as before) ... */
        const player = this.players[playerId];
        const hand = player.hands[handIndex];
        if (!player || !hand) { console.error("Invalid player or hand in _startOrContinuePlayerTurn"); this._advanceToNextHandOrPlayer(); return; }
        if (hand.isFromSplitAce && !this.config.rules.hitSplitAces && !hand.isStanding) {
            hand.isStanding = true;
            this.sendToPlayer(playerId, 'action_result', { handIndex: handIndex, hand: this._getClientHandData(hand), message: `Hand ${handIndex + 1} (Split Ace) automatically stands.`});
            if (this.broadcastUpdate) this.broadcastUpdate('player_action_taken', { playerId, seat: player.seat, action: 'stand_auto_ace', handIndex });
            this._advanceToNextHandOrPlayer(); return;
        }
        const possibleActions = this._getPossibleActions(playerId, handIndex);
        this.sendToPlayer(playerId, 'your_turn', { handIndex, possibleActions, turnTimeLimit: this.config.playerTurnTimeLimit, balance: player.balance });
        if (this.broadcastUpdate) this.broadcastUpdate('active_player_update', { activePlayerSeat: player.seat, activeHandIndex: handIndex, activePlayerId: playerId });
        this._restartTurnTimer(playerId, handIndex);
    }
    _restartTurnTimer(playerIdToRestartFor, handIndexToRestartFor) { /* ... (as before) ... */
        if (this.turnTimer) clearTimeout(this.turnTimer);
        const player = this.players[playerIdToRestartFor];
        if (!player || !player.hands[handIndexToRestartFor] || player.hands[handIndexToRestartFor].isStanding || player.hands[handIndexToRestartFor].isBusted || player.hands[handIndexToRestartFor].isSurrendered) return;
        this.turnTimer = setTimeout(() => {
            console.log(`Player ${player.nickname}'s turn timed out for hand ${handIndexToRestartFor + 1}. Auto-standing.`);
            this.handlePlayerAction(playerIdToRestartFor, { action: 'stand', handIndex: handIndexToRestartFor });
        }, this.config.playerTurnTimeLimit);
    }
    _getClientHandData(hand) { /* ... (as before) ... */
        return {
            cards: hand.cards.map(c => c.toPlainObject()),
            score: hand.score, bet: hand.bet, isBusted: hand.isBusted, isStanding: hand.isStanding,
            isDoubled: hand.isDoubled, isBlackjack: hand.isBlackjack, isSurrendered: hand.isSurrendered, isFromSplitAce: hand.isFromSplitAce
        };
    }
    _getOpponentHandData(hand) { /* ... (as before) ... */
        return {
            cards: hand.cards.map(c => c.toPlainObject()),
            score: hand.score, bet: hand.bet, isBusted: hand.isBusted, isStanding: hand.isStanding, isDoubled: hand.isDoubled
        };
    }

    // --- Dealer's Turn, Payouts, and Round End ---
    _dealerPlay() {
        if (this.gameState === 'GAME_OVER_MANUAL') return;
        console.log("GameManager: Dealer's turn.");
        this.gameState = 'DEALER_TURN_ACTIVE';
        this.activePlayerId = 'dealer';
        this.sendToAllPlayers('game_state_update', { gameState: this.gameState, message: "Dealer's turn." });


        if (this.dealer.hand.length === 2 && !this.dealer.revealedHoleCard) {
            this.dealer.revealedHoleCard = true;
            const holeCard = this.dealer.hand[1];
            this.sendToAllPlayers('dealer_hole_card_revealed', {
                holeCard: holeCard.toPlainObject(),
                dealerScore: this._calculateHandValue(this.dealer.hand).score
            });
        }

        const activePlayerHandsExist = Object.values(this.players).some(player =>
            player.hands.some(hand => !hand.isBusted && !hand.isSurrendered)
        );

        if (!activePlayerHandsExist) {
            console.log("GameManager: No active player hands remaining. Skipping dealer card drawing.");
            this._determinePayouts();
            return;
        }

        let dealerHitInterval = setInterval(() => {
            const dealerValue = this._calculateHandValue(this.dealer.hand);
            this.dealer.score = dealerValue.score;
            this.dealer.isBusted = dealerValue.isBust;

            if (this.dealer.isBusted) {
                this.sendToAllPlayers('dealer_action', { action: 'bust', score: this.dealer.score, hand: this.dealer.hand.map(c=>c.toPlainObject()) });
                clearInterval(dealerHitInterval);
                this._determinePayouts();
                return;
            }

            if (this.dealer.score < 17 || (this.dealer.score === 17 && this._isSoft17(this.dealer.hand))) {
                this._reshuffleIfNeeded();
                const newCard = this.shoe.dealCard();
                if (!newCard) {
                    console.error("Dealer turn: Shoe empty after reshuffle attempt!");
                    clearInterval(dealerHitInterval);
                    this._determinePayouts();
                    return;
                }
                this.dealer.hand.push(newCard);
                const updatedValue = this._calculateHandValue(this.dealer.hand);
                this.dealer.score = updatedValue.score;
                this.dealer.isBusted = updatedValue.isBust;

                const dealerCardMesh = this.createCardMesh(0,0,0, newCard, true); // Pos will be set by animation
                this.dealer.cardMeshes = this.dealer.cardMeshes || [];
                this.dealer.cardMeshes.push(dealerCardMesh);
                const targetX_dealer = -0.5 + ((this.dealer.hand.length -1) * (this.cardWidth + 0.1)); // Example position
                this.initiateCardAnimation(dealerCardMesh, {x: targetX_dealer, y: TARGET_CARD_Y_ON_TABLE, z: -1.0 }, this.scene);
                this.playSound('sounds/card_slide.mp3');

                this.sendToAllPlayers('dealer_action', {
                    action: 'hit',
                    newCard: newCard.toPlainObject(),
                    score: this.dealer.score,
                    isBusted: this.dealer.isBusted,
                    hand: this.dealer.hand.map(c=>c.toPlainObject())
                });
                 if (this.dealer.isBusted) { // Check bust again after sending hit update
                    clearInterval(dealerHitInterval);
                    this._determinePayouts();
                    return;
                }
            } else {
                this.sendToAllPlayers('dealer_action', { action: 'stand', score: this.dealer.score, hand: this.dealer.hand.map(c=>c.toPlainObject()) });
                clearInterval(dealerHitInterval);
                this._determinePayouts();
                return;
            }
        }, 1000);
    }

    _isSoft17(cards) {
        let score = 0; let aceCount = 0;
        for (const card of cards) {
            score += card.getValue();
            if (card.rank === 'Ace') aceCount++;
        }
        while (score > 21 && aceCount > 0) { score -= 10; aceCount--; }
        if (score !== 17) return false;
        // To be soft 17, an Ace must still be counting as 11.
        // Recalculate with all Aces as 1. If that score is < 17, then an Ace was 11.
        let scoreWithAcesAsOne = 0;
        for (const card of cards) {
            scoreWithAcesAsOne += (card.rank === 'Ace' ? 1 : card.getValue());
        }
        return scoreWithAcesAsOne < 17;
    }

    _determinePayouts() {
        console.log("GameManager: Determining payouts.");
        this.gameState = 'PAYOUTS_ACTIVE';
        this.roundEndMessages = this.roundEndMessages.filter(msg => msg.includes("Insurance") || msg.includes("Dealer has Natural Blackjack!"));

        const dealerHasNaturalBlackjack = this.dealer.hasNaturalBlackjack; // Set during dealing phase

        Object.values(this.players).forEach(player => {
            player.hands.forEach((hand, handIndex) => {
                if (hand.result !== null) return; // Already processed (e.g. surrender earlier)

                let resultString = '';
                let winnings = 0;
                let stakeReturned = 0;

                if (hand.isSurrendered) {
                    resultString = 'Surrendered';
                    stakeReturned = hand.bet / 2;
                    player.balance += stakeReturned;
                    // Message already added in playerSurrender
                } else if (dealerHasNaturalBlackjack) {
                    if (hand.isBlackjack) { // Player also has natural
                        resultString = 'Push (Both Natural Blackjack)';
                        stakeReturned = hand.bet;
                        player.balance += stakeReturned;
                    } else { // Player loses to dealer's natural
                        resultString = 'Loss (Dealer Natural Blackjack)';
                        // Bet already lost
                    }
                } else if (hand.isBlackjack) { // Player has natural, dealer does not
                    resultString = 'Blackjack!';
                    winnings = hand.bet * this.config.blackjackPayout;
                    stakeReturned = hand.bet;
                    player.balance += stakeReturned + winnings;
                } else if (hand.isBusted) {
                    resultString = 'Bust (Loss)';
                } else if (this.dealer.isBusted) {
                    resultString = 'Win (Dealer Bust)';
                    winnings = hand.bet;
                    stakeReturned = hand.bet;
                    player.balance += stakeReturned + winnings;
                } else if (hand.score > this.dealer.score) {
                    resultString = `Win (${hand.score} vs ${this.dealer.score})`;
                    winnings = hand.bet;
                    stakeReturned = hand.bet;
                    player.balance += stakeReturned + winnings;
                } else if (hand.score < this.dealer.score) {
                    resultString = `Loss (${hand.score} vs ${this.dealer.score})`;
                } else { // Push
                    resultString = `Push (${hand.score} vs ${this.dealer.score})`;
                    stakeReturned = hand.bet;
                    player.balance += stakeReturned;
                }
                hand.result = resultString;
                this.roundEndMessages.push(`Seat ${player.seat}, Hand ${handIndex + 1}: ${resultString}. Bet: ${hand.bet}. Won: ${winnings}. Stake returned: ${stakeReturned}.`);
                console.log(`Seat ${player.seat}, Hand ${handIndex + 1}: ${resultString}. Bet:${hand.bet}, Won:${winnings}, Stake Ret:${stakeReturned}. Bal: ${player.balance}`);
            });
            // Insurance payout already handled by resolveInsurance if dealer had natural.
            // If dealer did NOT have natural, insurance was lost (balance already deducted).
            player.insuranceBetAmount = 0; // Reset for player for this round
        });

        this.sendToAllPlayers('round_results', {
            resultsSummary: this.roundEndMessages,
            dealerHand: this.dealer.hand.map(c=>c.toPlainObject()),
            dealerScore: this.dealer.score,
            allPlayerFinalHands: Object.fromEntries( // Create an object { seatIndex: [handsData] }
                Object.values(this.players).map(p => [
                    p.seat,
                    p.hands.map(h => this._getClientHandData(h)) // Use existing helper
                ])
            )
        });
        this._endRound();
    }

    _endRound() {
        console.log("GameManager: Round ended.");
        this.gameState = 'ROUND_OVER';
        this.activePlayerId = null;
        this.activeHandIndex = 0;
        if (this.dealer) this.dealer.revealedHoleCard = false;

        Object.values(this.players).forEach(player => {
            this.sendToPlayer(player.id, 'player_balance_update', { balance: player.balance });
            player.isReadyForNextRound = false;
            player.insuranceBetAmount = 0; // Ensure it's cleared here too
            player.insuranceResponseMade = false; // Reset for next round
        });

        // Final accumulated messages for the round.
        const finalRoundMessage = this.roundEndMessages.join('<br>') + `<br>--- Round Over. Final Balances Updated. ---`;
        this.sendToAllPlayers('game_state_update', { gameState: this.gameState, message: finalRoundMessage });
        this.sendToAllPlayers('game_over_round_summary', { messages: this.roundEndMessages }); // More specific event for structured summary

        // Reset for next round
        this.insuranceResolved = false;
        this.roundEndMessages = [];

        // Optional: Auto-start next round
        console.log("GameManager: Scheduling next round start...");
        setTimeout(() => {
             if (Object.keys(this.players).length >= this.config.minPlayersToStart) {
                this.tryStartGame();
             } else {
                 this.gameState = 'WAITING_FOR_PLAYERS';
                 this.sendToAllPlayers('game_state_update', { gameState: this.gameState, message: `Waiting for at least ${this.config.minPlayersToStart} player(s) to start a new round.` });
             }
        }, 10000); // 10 second delay before new round betting
    }

    // Surrender methods (already implemented and commented from previous step)
    canPlayerSurrender() { /* ... */
        if (!this.config.rules.allowLateSurrender || this.isGameOver || this.askedInsurance) return false;
        if (this.playerHands.length === 1 && this.activeHandIndex === 0) {
            const hand = this.playerHands[0];
            if (hand.cards.length === 2 && !hand.isStanding && !hand.isBusted) return true;
        }
        return false;
    }
    playerSurrender() { /* ... */
        if (!this.canPlayerSurrender()) { this.uiUpdaters.displayMessage("Cannot surrender at this time."); return; }
        const hand = this.playerHands[this.activeHandIndex];
        hand.isSurrendered = true; hand.isStanding = true;
        this.roundEndMessages.push(`Seat ${this.players[this.activePlayerId].seat}, Hand ${this.activeHandIndex + 1} surrendered. Half bet is forfeit.`);
        this.isPlayerTurn = false;
        this.activePlayerId = null; // No more active player for turns
        this.sendToAllPlayers('player_action_taken', {playerId: this.activePlayerId, seat:this.players[this.activePlayerId].seat, action:'surrender', handIndex: this.activeHandIndex});
        this._dealerPlay(); // If one player surrenders, others might still play or dealer plays.
                           // For single player context, this effectively moves to dealer then payout.
                           // For multiple players, it should advance to next player or dealer.
                           // For now, simplified: assume surrender ends player's involvement.
                           // If all players surrender/bust, dealer might not need to play.
                           // The _dealerPlay checks if active hands exist.
    }
    isBust(score) { return score > 21; }
}

module.exports = GameManager;
