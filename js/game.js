// js/game.js - Core Blackjack game logic.

const TARGET_CARD_Y_ON_TABLE = -0.965;

class Game {
    constructor(scene, gameConfig, cardWidth, createChipMeshFn, chipValuesColors, chipHeight, uiUpdaters, createCardMeshFn, initiateCardAnimationFn, playSoundFn, initiateCardFlipFn) { // Added initiateCardFlipFn
        this.scene = scene;
        this.config = gameConfig;
        this.cardWidth = cardWidth;
        this.createChipMesh = createChipMeshFn;
        this.createCardMesh = createCardMeshFn;
        this.initiateCardAnimation = initiateCardAnimationFn;
        this.initiateCardFlip = initiateCardFlipFn; // Store it
        this.playSound = playSoundFn;
        this.chipValuesColors = chipValuesColors;
        this.chipHeight = chipHeight;
        this.uiUpdaters = uiUpdaters;
        this.socket = null; // Placeholder for socket if passed later, currently main.js passes it as last arg

        this.shoe = new Deck(this.config.numberOfDecks);
        this.shoe.shuffle();

        this.playerHands = [];
        this.activeHandIndex = 0;
        this.dealerHand = [];
        this.dealerCardMeshes = [];

        this.totalPlayerBet = 0;
        this.currentBetChipMeshes = [];

        this.isPlayerTurn = false;
        this.isGameOver = false;
        this.dealerScore = 0;

        this.insuranceBetAmount = 0;
        this.askedInsurance = false;
        this.insuranceResolved = false;
        this.roundEndMessages = [];
        this.playerBalance = 1000; // Starting player balance
    }

    _createPlayerHand(initialBet = 0) {
        if (this.playerBalance < initialBet) {
            console.warn(`Not enough balance (${this.playerBalance}) to place bet of ${initialBet}. Bet reduced.`);
            initialBet = this.playerBalance > 0 ? this.playerBalance : 0; // Bet what's available or 0
        }
        this.playerBalance -= initialBet;
        console.log(`Bet placed: ${initialBet} for new hand. New balance: ${this.playerBalance}`);
        if(this.uiUpdaters.updatePlayerBalance) this.uiUpdaters.updatePlayerBalance(this.playerBalance);

        return {
            cards: [], score: 0, bet: initialBet,
            isStanding: false, isBusted: false,
            cardMeshes: [], isDoubled: false,
            isFromSplitAce: false,
            isBlackjack: false,
            isSurrendered: false
        };
    }

    clearBet() {
        this.currentBetChipMeshes.forEach(mesh => { if (mesh && this.scene) this.scene.remove(mesh); });
        this.currentBetChipMeshes = [];
        this.totalPlayerBet = 0;
        // Bets are returned or settled in determineWinner, so hand.bet should be 0 after that.
        // Here, we just ensure the visual display and total are cleared.

        this.insuranceBetAmount = 0;
        this.askedInsurance = false;
        this.insuranceResolved = false;
        if (this.uiUpdaters.hideInsuranceBetDisplay) this.uiUpdaters.hideInsuranceBetDisplay();
    }

    displayBetChips(betAmountToDisplay) { // betAmountToDisplay is usually this.totalPlayerBet
        this.currentBetChipMeshes.forEach(mesh => { if (mesh && this.scene) this.scene.remove(mesh); });
        this.currentBetChipMeshes = [];
        // totalPlayerBet is the sum of all hand bets that are currently active on table
        // This function just VISUALIZES it. Actual bet amounts are per hand.
        console.log(`Displaying chips for total table bet: ${betAmountToDisplay}`);

        const BETTING_AREA_X = 0;
        const BETTING_AREA_Z = 0.7;
        const BET_CHIP_Y_BASE = -0.99 + this.chipHeight / 2;

        let remainingAmount = betAmountToDisplay;
        const chipDenominations = Object.keys(this.chipValuesColors).map(Number).sort((a, b) => b - a);
        let currentStackHeight = 0;

        for (const value of chipDenominations) {
            while (remainingAmount >= value) {
                const chipMesh = this.createChipMesh(BETTING_AREA_X, BET_CHIP_Y_BASE + currentStackHeight, BETTING_AREA_Z, value);
                if (chipMesh) {
                    this.scene.add(chipMesh);
                    this.currentBetChipMeshes.push(chipMesh);
                    remainingAmount -= value;
                    currentStackHeight += this.chipHeight;
                } else { return; }
            }
        }
        if (remainingAmount > 0) console.warn("Could not make exact visual bet with available chip denominations for display.");
        this.uiUpdaters.updateBet(betAmountToDisplay);
        if (betAmountToDisplay > 0 && this.currentBetChipMeshes.length === 0 && betAmountToDisplay > 0) {
             // If bet is too small for any chip, log it.
             console.warn(`Bet amount ${betAmountToDisplay} too small to display with current chip denominations.`);
        }
        // Play sound only if chips were actually added or changed significantly
        // This check might need refinement; for now, play if >0 and some chips were added
        if (betAmountToDisplay > 0 && this.currentBetChipMeshes.length > 0) {
            this.playSound('sounds/chip_place.mp3');
        }
    }

    _getHandStatusString(hand, handIndex) {
        if (hand.isSurrendered) return "Surrendered";
        if (hand.isBlackjack) return "Blackjack!";
        if (hand.isBusted) return "Busted!";
        if (hand.isStanding) return "Stood";
        if (this.isPlayerTurn && !this.isGameOver && handIndex === this.activeHandIndex) return "Active";
        return "Waiting";
    }

    updatePlayerUI() {
        const handsDataArray = this.playerHands.map((hand, index) => ({
            cardsString: hand.cards.map(c => c.toString()).join(', '),
            score: hand.score, bet: hand.bet,
            statusString: this._getHandStatusString(hand, index)
        }));
        this.uiUpdaters.updatePlayer(handsDataArray, this.activeHandIndex);
    }

    updateDealerUI(revealAll = false) { /* ... (no changes from previous state) ... */
        let handString; let scoreToDisplay;
        if (revealAll || this.isGameOver || !this.isPlayerTurn) {
            handString = this.dealerHand.map(card => card.toString()).join(', ');
            scoreToDisplay = this.dealerScore;
        } else {
            handString = this.dealerHand.length > 0 ? `${this.dealerHand[0].toString()}, [Hidden Card]` : "";
            scoreToDisplay = this.dealerHand.length > 0 ? this.dealerHand[0].getValue() : 0;
        }
        this.uiUpdaters.updateDealer(handString, scoreToDisplay);
    }
    canPlayerDoubleDown(handIndex = this.activeHandIndex) { /* ... (no changes from previous state) ... */
        const hand = this.playerHands[handIndex];
        if (!this.isPlayerTurn || this.isGameOver || !hand || hand.cards.length !== 2 || hand.isStanding || hand.isBusted || hand.isDoubled) {
            return false;
        }
        if (this.playerHands.length > 1 && !this.config.rules.doubleAfterSplit) {
            return false;
        }
        if (hand.isFromSplitAce && !this.config.rules.hitSplitAces) {
            return false;
        }
        return true;
    }
    canPlayerSplit() { /* ... (no changes from previous state) ... */
        if (this.playerHands.length >= this.config.maxSplitHands) return false;
        const hand = this.playerHands[this.activeHandIndex];
        if (!hand || hand.isStanding || hand.isBusted) return false;
        return this.isPlayerTurn && !this.isGameOver && hand.cards.length === 2 && hand.cards[0].rank === hand.cards[1].rank;
    }
    calculateHandValue(cardsArray) { /* ... (no changes from previous state) ... */
        let score = 0; let aceCount = 0;
        cardsArray.forEach(card => { score += card.getValue(); if (card.rank === "Ace") aceCount++; });
        while (score > 21 && aceCount > 0) { score -= 10; aceCount--; }
        return score;
    }
    reshuffleShoe() { /* ... (no changes from previous state) ... */
        this.uiUpdaters.displayMessage("Reshuffling shoe...");
        this.shoe = new Deck(this.config.numberOfDecks);
        this.shoe.shuffle();
        console.log(`Shoe reshuffled with ${this.shoe.cardsRemaining()} cards.`);
    }

    startGame(betAmount = 10) {
        this.clearBet();
        this.isPlayerTurn = true; this.isGameOver = false; this.activeHandIndex = 0;
        this.insuranceResolved = false; this.roundEndMessages = [];
        // Initial balance display at game start (after potential reset in clearBet)
        if(this.uiUpdaters.updatePlayerBalance) this.uiUpdaters.updatePlayerBalance(this.playerBalance);

        this.playerHands.forEach(h => h.cardMeshes.forEach(m => { if(m) this.scene.remove(m); }));

        const initialHand = this._createPlayerHand(betAmount); // Bet deducted from balance here
        this.playerHands = [initialHand];
        this.totalPlayerBet = initialHand.bet; // totalPlayerBet reflects actual bet placed if balance allowed

        if (initialHand.bet > 0) { // Only display chips if a valid bet was made
            this.displayBetChips(this.totalPlayerBet);
        } else { // No valid bet could be made (e.g. zero balance)
            this.uiUpdaters.displayMessage("Not enough balance to start game with the intended bet. Please reset or add funds.");
            this.isGameOver = true; // Cannot start game
            this.uiUpdaters.updateButtons({ canHit: false, canStand: false, canDouble: false, canSplit: false, canSurrender: false, showNewGame: true });
            return;
        }


        this.dealerHand = [];
        this.dealerCardMeshes.forEach(m => { if(m) this.scene.remove(m); });
        this.dealerCardMeshes = [];

        const initialCardsNeeded = 2 + 2;
        const penetrationThreshold = this.config.numberOfDecks * 52 * (1 - this.config.shoePenetrationPercent);
        if (!this.shoe.hasEnoughCards(initialCardsNeeded) || this.shoe.cardsRemaining() < penetrationThreshold) {
            this.reshuffleShoe();
        }

        initialHand.cards.push(this.shoe.dealCard(), this.shoe.dealCard());
        this.dealerHand.push(this.shoe.dealCard(), this.shoe.dealCard());

        initialHand.score = this.calculateHandValue(initialHand.cards);
        initialHand.isBlackjack = (initialHand.score === 21 && initialHand.cards.length === 2);
        this.dealerScore = this.calculateHandValue(this.dealerHand);

        this._setupInitialCardMeshes();
        console.log("---- GAME STARTED ----");
        this.updatePlayerUI();
        this.updateDealerUI(false);

        const playerHasBlackjack = initialHand.isBlackjack;
        const dealerHasNaturalBlackjack = this.dealerScore === 21 && this.dealerHand.length === 2;

        if (playerHasBlackjack && dealerHasNaturalBlackjack) {
            this.updateDealerUI(true);
            this.roundEndMessages.push("Push! Both have Blackjack.");
            this.resolveInsurance(true);
            this.endGame(true);
        } else if (playerHasBlackjack) {
            this.roundEndMessages.push("Player Blackjack! Player wins!");
            this.endGame(true);
        } else if (dealerHasNaturalBlackjack) {
            this.updateDealerUI(true);
            this.resolveInsurance(true);
            this.roundEndMessages.push("Dealer Blackjack! Dealer wins!");
            this.endGame(true);
        } else {
            if (this.dealerHand[0] && this.dealerHand[0].rank === 'Ace') {
                this.offerInsurance();
            } else {
                this.uiUpdaters.displayMessage("Player's turn. Hit, Stand, Double, or Split?");
                this.updateButtonStates();
            }
        }
    }

    _setupInitialCardMeshes() { /* ... (no changes from previous state) ... */
        const hand = this.playerHands[0];
        hand.cardMeshes.forEach(m => { if(m) this.scene.remove(m); });
        hand.cardMeshes = [];
        const PLAYER_BASE_X = -0.5, PLAYER_Z_HAND_0 = 1.5;
        hand.cards.forEach((card, index) => {
            const targetX = PLAYER_BASE_X + (index * (this.cardWidth + 0.1));
            const cardMesh = this.createCardMesh(targetX, TARGET_CARD_Y_ON_TABLE, PLAYER_Z_HAND_0);
            hand.cardMeshes.push(cardMesh);
            this.initiateCardAnimation(cardMesh, { x: targetX, y: TARGET_CARD_Y_ON_TABLE, z: PLAYER_Z_HAND_0 }, this.scene);
        });
        if (hand.cards.length > 0) this.playSound('sounds/card_slide.mp3');

        this.dealerCardMeshes.forEach(m => { if(m) this.scene.remove(m); });
        this.dealerCardMeshes = [];
        const DEALER_BASE_X = -0.5, DEALER_Z = -1.0;
        this.dealerHand.forEach((card, index) => {
            const isFaceUp = (index === 0); // First dealer card (upcard) is face up, second (hole card) is face down
            const targetX = DEALER_BASE_X + (index * (this.cardWidth + 0.1));
            const cardMesh = this.createCardMesh(targetX, TARGET_CARD_Y_ON_TABLE, DEALER_Z, card, isFaceUp);
            this.dealerCardMeshes.push(cardMesh);
            this.initiateCardAnimation(cardMesh, { x: targetX, y: TARGET_CARD_Y_ON_TABLE, z: DEALER_Z }, this.scene);
        });
        if (this.dealerHand.length > 0) this.playSound('sounds/card_slide.mp3');
    }
    updateButtonStates() { /* ... (no changes from previous state, already includes canSurrender) ... */
        const currentHand = this.playerHands[this.activeHandIndex];
        let canHit = this.isPlayerTurn && !this.isGameOver && currentHand && !currentHand.isStanding && !currentHand.isBusted;
        const canStand = this.isPlayerTurn && !this.isGameOver && currentHand && !currentHand.isStanding && !currentHand.isBusted;

        let canDouble = canHit && currentHand.cards.length === 2 && !currentHand.isDoubled;
        if (this.playerHands.length > 1 && !this.config.rules.doubleAfterSplit) {
            canDouble = false;
        }

        if (currentHand && currentHand.isFromSplitAce && !this.config.rules.hitSplitAces) {
            canHit = false;
            if (!this.config.rules.doubleAfterSplit && currentHand.isFromSplitAce){
                 canDouble = false;
            }
        }

        const canSplit = this.canPlayerSplit();
        const canSurrender = this.canPlayerSurrender();
        this.uiUpdaters.updateButtons({ canHit, canStand, canDouble, canSplit, canSurrender, showNewGame: false });
    }

    offerInsurance() { /* ... (no changes from previous state) ... */
        this.askedInsurance = true;
        const insuranceCost = this.totalPlayerBet / 2;
        this.uiUpdaters.promptInsurance(insuranceCost);
        this.uiUpdaters.updateButtons({ canHit: false, canStand: false, canDouble: false, canSplit: false, canSurrender: false, showNewGame: false });
        this.uiUpdaters.displayMessage("Dealer has an Ace. Insurance offered.");
    }
    playerTakesInsurance() {
        if (!this.askedInsurance) return;
        const insuranceCost = this.totalPlayerBet / 2;
        if (this.playerBalance >= insuranceCost) {
            this.insuranceBetAmount = insuranceCost;
            this.playerBalance -= this.insuranceBetAmount;
            console.log(`Insurance bet: ${this.insuranceBetAmount}, New balance: ${this.playerBalance}`);
            if(this.uiUpdaters.updatePlayerBalance) this.uiUpdaters.updatePlayerBalance(this.playerBalance);
            if (this.uiUpdaters.updateInsuranceBetDisplay) this.uiUpdaters.updateInsuranceBetDisplay(this.insuranceBetAmount);
            this.playSound('sounds/chip_place.mp3');
            this.uiUpdaters.displayMessage(`Insurance taken for ${this.insuranceBetAmount}. Player's turn.`);
        } else {
            this.uiUpdaters.displayMessage("Not enough balance for insurance.");
        }
        if (this.uiUpdaters.hideInsurancePrompt) this.uiUpdaters.hideInsurancePrompt();
        this.askedInsurance = false;
        this.updateButtonStates();
    }
    playerDeclinesInsurance() { /* ... (no changes from previous state) ... */
        if (!this.askedInsurance) return;
        if (this.uiUpdaters.hideInsurancePrompt) this.uiUpdaters.hideInsurancePrompt();
        this.askedInsurance = false;
        this.uiUpdaters.displayMessage("Insurance declined. Player's turn.");
        this.updateButtonStates();
    }
    resolveInsurance(dealerHasNaturalBlackjack) {
        if (this.insuranceBetAmount > 0 && !this.insuranceResolved) {
            let insuranceMessage = "";
            if (dealerHasNaturalBlackjack) {
                const payout = this.insuranceBetAmount * 2;
                this.playerBalance += this.insuranceBetAmount + payout;
                insuranceMessage = `Dealer has Natural Blackjack! Insurance PAYS ${payout}. Stake returned: ${this.insuranceBetAmount}.`;
                console.log(`Insurance won. Payout: ${payout}, Stake returned: ${this.insuranceBetAmount}. New balance: ${this.playerBalance}`);
            } else {
                insuranceMessage = `Dealer does not have Natural Blackjack. Insurance lost (-${this.insuranceBetAmount}).`;
                console.log(`Insurance lost. Bet was: ${this.insuranceBetAmount}. Balance for insurance part: ${this.playerBalance}`);
            }
            this.roundEndMessages.push(insuranceMessage);
            this.insuranceResolved = true;
            // Balance display updated at end of round or if specific UI for insurance win/loss exists
        }
    }

    endGame(isBlackjackOrBust = false) {
        this.isGameOver = true; this.isPlayerTurn = false;

        if (!isBlackjackOrBust) {
            this.determineWinner();
        }

        if (this.insuranceBetAmount > 0 && !this.insuranceResolved) {
            this.resolveInsurance(false);
        }

        this.updatePlayerUI();
        this.updateDealerUI(true);

        this.roundEndMessages.push(`Round ended. Final balance: ${this.playerBalance}`);
        console.log(`Player balance at end of round: ${this.playerBalance}`);
        if(this.uiUpdaters.updatePlayerBalance) this.uiUpdaters.updatePlayerBalance(this.playerBalance);

        this.uiUpdaters.displayMessage(this.roundEndMessages.join("<br>"));
        this.uiUpdaters.updateButtons({ canHit: false, canStand: false, canDouble: false, canSplit: false, canSurrender: false, showNewGame: true });

        this.insuranceBetAmount = 0; this.askedInsurance = false; this.insuranceResolved = false;
        if (this.uiUpdaters.hideInsuranceBetDisplay) this.uiUpdaters.hideInsuranceBetDisplay();
    }

    playerDoubleDown() {
        const hand = this.playerHands[this.activeHandIndex];
        if (!this.canPlayerDoubleDown()) { this.uiUpdaters.displayMessage("Cannot Double Down now."); return; }

        const additionalBet = hand.bet;
        if (this.playerBalance >= additionalBet) {
            this.playerBalance -= additionalBet;
            hand.bet += additionalBet;
            this.totalPlayerBet += additionalBet;
            console.log(`Doubled bet, additional: ${additionalBet}, New balance: ${this.playerBalance}. Hand bet: ${hand.bet}`);
            if(this.uiUpdaters.updatePlayerBalance) this.uiUpdaters.updatePlayerBalance(this.playerBalance);
            this.displayBetChips(this.totalPlayerBet);

            this.uiUpdaters.displayMessage(`Hand ${this.activeHandIndex + 1} Doubles Down!`);
            hand.isDoubled = true;

            if (!this.shoe.hasEnoughCards(1)) this.reshuffleShoe();
            hand.cards.push(this.shoe.dealCard());
            hand.score = this.calculateHandValue(hand.cards);

            const PLAYER_BASE_X = -1.0, PLAYER_Z_BASE = 1.5;
            const HAND_X_OFFSET_MULTIPLIER = 1.5;
            const handSpecificBaseX = PLAYER_BASE_X + (this.activeHandIndex * (this.cardWidth * HAND_X_OFFSET_MULTIPLIER));
            const newCardIndex = hand.cards.length - 1;
            const targetX_dd = handSpecificBaseX + (newCardIndex * (this.cardWidth + 0.1));
            const cardMesh_dd = this.createCardMesh(targetX_dd, TARGET_CARD_Y_ON_TABLE, PLAYER_Z_BASE);
            hand.cardMeshes.push(cardMesh_dd);
            this.initiateCardAnimation(cardMesh_dd, { x: targetX_dd, y: TARGET_CARD_Y_ON_TABLE, z: PLAYER_Z_BASE }, this.scene);
            this.playSound('sounds/card_slide.mp3');

            if (this.isBust(hand.score)) {
                hand.isBusted = true;
                this.roundEndMessages.push(`Hand ${this.activeHandIndex + 1} busts with ${hand.score}!`);
            } else {
                this.roundEndMessages.push(`Hand ${this.activeHandIndex + 1} has ${hand.score}.`);
            }
            hand.isStanding = true;
            this._advanceToNextPlayableHandOrDealer();
        } else {
            this.uiUpdaters.displayMessage("Not enough balance to double down.");
            // Button state should remain as is, allowing player to choose another action
            this.updateButtonStates();
        }
    }

    playerHit() { /* ... (no payout changes, only uses shoe) ... */
        const hand = this.playerHands[this.activeHandIndex];
        if (!this.isPlayerTurn || this.isGameOver || !hand || hand.isStanding || hand.isBusted) return;

        if (!this.shoe.hasEnoughCards(1)) this.reshuffleShoe();
        hand.cards.push(this.shoe.dealCard());
        hand.score = this.calculateHandValue(hand.cards);
        this.updatePlayerUI();

        const PLAYER_BASE_X = -1.0, PLAYER_Z_BASE = 1.5;
        const HAND_X_OFFSET_MULTIPLIER = 1.5;
        const handSpecificBaseX = PLAYER_BASE_X + (this.activeHandIndex * (this.cardWidth * HAND_X_OFFSET_MULTIPLIER));
        const newCardIndex = hand.cards.length - 1;
        const targetX = handSpecificBaseX + (newCardIndex * (this.cardWidth + 0.1));
        const cardMesh = this.createCardMesh(targetX, TARGET_CARD_Y_ON_TABLE, PLAYER_Z_BASE);
        hand.cardMeshes.push(cardMesh);
        this.initiateCardAnimation(cardMesh, { x: targetX, y: TARGET_CARD_Y_ON_TABLE, z: PLAYER_Z_BASE }, this.scene);
        this.playSound('sounds/card_slide.mp3');

        if (this.isBust(hand.score)) {
            hand.isBusted = true;
            this.roundEndMessages.push(`Hand ${this.activeHandIndex + 1} busts!`);
            this._advanceToNextPlayableHandOrDealer();
        } else {
             this.updateButtonStates();
        }
    }
    playerStand() { /* ... (no payout changes) ... */
        const hand = this.playerHands[this.activeHandIndex];
        if (!this.isPlayerTurn || this.isGameOver || !hand) {
            return;
        }

        if (!hand.isStanding && !hand.isBusted) {
            hand.isStanding = true;
            this.roundEndMessages.push(`Hand ${this.activeHandIndex + 1} stands with ${hand.score}.`);
            this.updatePlayerUI();
        }

        this._advanceToNextPlayableHandOrDealer();
    }
    dealerPlay() { /* ... (no direct player payout changes) ... */
        if (this.playerHands.every(hand => hand.isBusted || hand.isSurrendered)) {
            this.roundEndMessages.push("All player hands resolved (busted/surrendered). Dealer wins by default.");
            this.endGame(true); return;
        }
        this.isPlayerTurn = false;
        this.uiUpdaters.updateButtons({ canHit: false, canStand: false, canDouble: false, canSplit: false, canSurrender: false, showNewGame: false });
        this.uiUpdaters.displayMessage("Dealer is playing...");

        // Reveal hole card (if it's not already face up)
        const dealerHoleCardMesh = this.dealerCardMeshes[1];
        let mustFlip = false;
        if (dealerHoleCardMesh && !dealerHoleCardMesh.userData.isFaceUp) {
            mustFlip = true;
            this.initiateCardFlip(dealerHoleCardMesh, () => {
                // After flip, ensure UI shows both cards and correct score, then proceed with hits
                this.dealerScore = this.calculateHandValue(this.dealerHand);
                this.updateDealerUI(true);
                this._dealerHitLogic(); // Start hitting after flip completes
            });
        } else {
            // If card already face up (e.g. testing) or no hole card mesh, proceed directly
            this.dealerScore = this.calculateHandValue(this.dealerHand);
            this.updateDealerUI(true);
            this._dealerHitLogic();
        }
    }

    // Extracted dealer hitting logic to be callable after flip animation
    _dealerHitLogic() {
        const dealerActionInterval = setInterval(() => {
            if (this.dealerScore < 17) {
                this.uiUpdaters.displayMessage("Dealer hits.");
                if (!this.shoe.hasEnoughCards(1)) this.reshuffleShoe();
                const newCard = this.shoe.dealCard();

                if (newCard) {
                    this.dealerHand.push(newCard);
                    this.dealerScore = this.calculateHandValue(this.dealerHand); this.updateDealerUI(true);

                    const DEALER_BASE_X = -0.5, DEALER_Z_POS = -1.0;
                    const newDealerCardIndex = this.dealerHand.length - 1;
                    const targetX_dealer = DEALER_BASE_X + (newDealerCardIndex * (this.cardWidth + 0.1));
                    const dealerCardMesh = this.createCardMesh(targetX_dealer, TARGET_CARD_Y_ON_TABLE, DEALER_Z_POS);
                    this.dealerCardMeshes.push(dealerCardMesh);
                    this.initiateCardAnimation(dealerCardMesh, { x: targetX_dealer, y: TARGET_CARD_Y_ON_TABLE, z: DEALER_Z_POS }, this.scene);
                    this.playSound('sounds/card_slide.mp3');

                    if (this.isBust(this.dealerScore)) {
                        this.roundEndMessages.push("Dealer busts!");
                        clearInterval(dealerActionInterval); this.endGame(true);
                        return;
                    }
                } else {
                     console.error("Dealer failed to draw a card after reshuffle attempt.");
                     clearInterval(dealerActionInterval);
                     this.uiUpdaters.displayMessage("Error: Dealer cannot draw card. Game halted.");
                     this.isGameOver = true; this.isPlayerTurn = false;
                     this.uiUpdaters.updateButtons({ canHit: false, canStand: false, canDouble: false, canSplit: false, canSurrender: false, showNewGame: true });
                     return;
                }
            } else {
                this.roundEndMessages.push(`Dealer stands with ${this.dealerScore}.`);
                clearInterval(dealerActionInterval); this.endGame(false);
                return;
            }
        }, 1000);
    }

    determineWinner() {
        // Clear previous round's specific hand outcomes before populating new ones
        this.roundEndMessages = this.roundEndMessages.filter(msg =>
            msg.includes("Insurance PAYS") || msg.includes("Insurance lost") || msg.includes("Dealer has Natural Blackjack!")
        ); // Keep insurance messages

        const dealerHasNaturalBlackjack = this.dealerScore === 21 && this.dealerHand.length === 2; // Check at the time of comparison

        this.playerHands.forEach((hand, index) => {
            let handWinnings = 0;
            let handMessage = `Hand ${index + 1} (${hand.score}): `;

            if (hand.isSurrendered) {
                handWinnings = hand.bet / 2;
                this.playerBalance += handWinnings;
                handMessage += `Surrendered. Bet returned: ${handWinnings}.`;
            } else if (dealerHasNaturalBlackjack && !hand.isBlackjack) { // Dealer natural vs player non-BJ
                handWinnings = 0;
                handMessage += `Loses to Dealer's Natural Blackjack.`;
            } else if (hand.isBlackjack) { // Player natural
                if (dealerHasNaturalBlackjack) { // Both natural
                    handWinnings = hand.bet;
                    this.playerBalance += handWinnings;
                    handMessage += `Push (Both have Natural Blackjack). Bet returned: ${handWinnings}.`;
                } else { // Player natural, dealer no natural
                    handWinnings = hand.bet + (hand.bet * this.config.blackjackPayout);
                    this.playerBalance += handWinnings;
                    handMessage += `Blackjack! Paid: ${hand.bet * this.config.blackjackPayout}. Total returned: ${handWinnings}.`;
                }
            } else if (hand.isBusted) {
                handWinnings = 0;
                handMessage += `Busted. Bet lost.`;
            } else if (this.dealerScore > 21) { // Dealer busts, player hand is not busted
                handWinnings = hand.bet * 2;
                this.playerBalance += handWinnings;
                handMessage += `Dealer busts. Player wins! Total returned: ${handWinnings}.`;
            } else if (hand.score > this.dealerScore) {
                handWinnings = hand.bet * 2;
                this.playerBalance += handWinnings;
                handMessage += `Wins (${hand.score} vs ${this.dealerScore}). Total returned: ${handWinnings}.`;
            } else if (this.dealerScore > hand.score) {
                handWinnings = 0;
                handMessage += `Loses (${hand.score} vs ${this.dealerScore}).`;
            } else { // Push
                handWinnings = hand.bet;
                this.playerBalance += handWinnings;
                handMessage += `Push (${hand.score} vs ${this.dealerScore}). Bet returned: ${handWinnings}.`;
            }
            this.roundEndMessages.push(handMessage);
            console.log(`Hand ${index+1} outcome: Bet ${hand.bet}, Winnings (incl. stake back): ${handWinnings}, Player balance now: ${this.playerBalance}`);
        });
    }

    isBust(score) { return score > 21; }
    _advanceToNextPlayableHandOrDealer() { /* ... (no changes from previous state) ... */
        const currentHand = this.playerHands[this.activeHandIndex];
        if (currentHand && !currentHand.isStanding && !currentHand.isBusted) {
            this.updateButtonStates();
            return;
        }
        this.activeHandIndex++;
        while (this.activeHandIndex < this.playerHands.length &&
               (this.playerHands[this.activeHandIndex].isBusted || this.playerHands[this.activeHandIndex].isStanding)) {
            this.activeHandIndex++;
        }
        if (this.activeHandIndex >= this.playerHands.length) {
            this.isPlayerTurn = false;
            this.uiUpdaters.displayMessage("All player hands complete. Dealer's turn.");
            this.dealerPlay();
        } else {
            this.uiUpdaters.displayMessage(`Playing hand ${this.activeHandIndex + 1}.`);
            const newActiveHand = this.playerHands[this.activeHandIndex];
            if (newActiveHand.isFromSplitAce && !this.config.rules.hitSplitAces && !newActiveHand.isStanding) {
                newActiveHand.isStanding = true;
                this.roundEndMessages.push(`Hand ${this.activeHandIndex + 1} (Split Ace) stands with ${newActiveHand.score}.`);
                this._advanceToNextPlayableHandOrDealer();
                return;
            }
        }
        this.updatePlayerUI();
        this.updateButtonStates();
    }
    playerSplit() { /* ... (balance change for split hand already added) ... */
        if (!this.canPlayerSplit()) {
            this.uiUpdaters.displayMessage("Cannot split now.");
            this.updateButtonStates(); return;
        }

        const hand1 = this.playerHands[this.activeHandIndex];
        const betForNewSplitHand = hand1.bet;

        if (this.playerBalance < betForNewSplitHand) {
            this.uiUpdaters.displayMessage("Not enough balance to split.");
            return;
        }
        this.playerBalance -= betForNewSplitHand;
        console.log(`Split bet: ${betForNewSplitHand}, New balance: ${this.playerBalance}`);
        if(this.uiUpdaters.updatePlayerBalance) this.uiUpdaters.updatePlayerBalance(this.playerBalance);

        this.uiUpdaters.displayMessage("Player splits!");
        const hand2 = this._createPlayerHand(betForNewSplitHand); // This will deduct from balance again, which is wrong.
                                                                // _createPlayerHand should not deduct. Bet placement should.
                                                                // Let's correct _createPlayerHand to NOT deduct,
                                                                // and manage deductions in calling methods.
        // Correction: hand2.bet is already set by _createPlayerHand.
        // We already deducted for hand1. For hand2, the bet is set, and balance deducted when hand2 is created.
        // The playerBalance update in _createPlayerHand handles this.
        // However, _createPlayerHand now takes initialBet which *is* the bet.
        // The issue is that totalPlayerBet needs to be sum of actual hand.bet values on table.

        // Let's fix _createPlayerHand to NOT modify balance.
        // Balance modification should happen in startGame, playerSplit, playerDoubleDown, playerTakesInsurance.
        // For playerSplit, hand2's bet is already set from hand1.bet.
        // The additional bet for hand2 needs to be deducted here.
        // So, the above playerBalance deduction for betForNewSplitHand is correct.
        // hand2 is then created with this bet but _createPlayerHand won't re-deduct.
        // The _createPlayerHand should NOT call updatePlayerBalance. That should be done after all balance changes for an action.

        this.totalPlayerBet += hand2.bet; // Add hand2's bet to total on table
        this.displayBetChips(this.totalPlayerBet);

        hand2.cards.push(hand1.cards.pop());
        this.playerHands.splice(this.activeHandIndex + 1, 0, hand2);

        if (!this.shoe.hasEnoughCards(2)) this.reshuffleShoe();
        hand1.cards.push(this.shoe.dealCard());
        if (!this.shoe.hasEnoughCards(1)) this.reshuffleShoe();
        hand2.cards.push(this.shoe.dealCard());

        hand1.score = this.calculateHandValue(hand1.cards);
        hand2.score = this.calculateHandValue(hand2.cards);

        const wasAceSplit = (hand1.cards[0].rank === 'Ace' || hand2.cards[0].rank === 'Ace');
        hand1.isFromSplitAce = wasAceSplit; hand2.isFromSplitAce = wasAceSplit;

        hand1.isBlackjack = (hand1.score === 21 && hand1.cards.length === 2 && !(wasAceSplit && !this.config.rules.blackjackAfterSplitAces));
        hand2.isBlackjack = (hand2.score === 21 && hand2.cards.length === 2 && !(wasAceSplit && !this.config.rules.blackjackAfterSplitAces));

        if (hand1.cardMeshes.length > 0) {
            const meshToMove = hand1.cardMeshes.pop(); hand2.cardMeshes.push(meshToMove);
        }

        const PLAYER_Z_SPLIT = 1.5;
        const HAND_X_BASE = -1.0;
        const HAND_X_SEPARATION = 1.8 * this.cardWidth;

        const hand1_posX_base = HAND_X_BASE + (this.activeHandIndex * HAND_X_SEPARATION);
        if(hand1.cardMeshes[0]) hand1.cardMeshes[0].position.set(hand1_posX_base, TARGET_CARD_Y_ON_TABLE, PLAYER_Z_SPLIT);

        const targetX_newCard1 = hand1_posX_base + (this.cardWidth + 0.1);
        let newCardMesh1 = this.createCardMesh(targetX_newCard1, TARGET_CARD_Y_ON_TABLE, PLAYER_Z_SPLIT);
        hand1.cardMeshes.push(newCardMesh1);
        this.initiateCardAnimation(newCardMesh1, {x: targetX_newCard1, y: TARGET_CARD_Y_ON_TABLE, z: PLAYER_Z_SPLIT}, this.scene);
        this.playSound('sounds/card_slide.mp3');

        const hand2_posX_base = HAND_X_BASE + ((this.activeHandIndex + 1) * HAND_X_SEPARATION);
        if(hand2.cardMeshes[0]) hand2.cardMeshes[0].position.set(hand2_posX_base, TARGET_CARD_Y_ON_TABLE, PLAYER_Z_SPLIT);

        const targetX_newCard2 = hand2_posX_base + (this.cardWidth + 0.1);
        let newCardMesh2 = this.createCardMesh(targetX_newCard2, TARGET_CARD_Y_ON_TABLE, PLAYER_Z_SPLIT);
        hand2.cardMeshes.push(newCardMesh2);
        this.initiateCardAnimation(newCardMesh2, {x: targetX_newCard2, y: TARGET_CARD_Y_ON_TABLE, z: PLAYER_Z_SPLIT}, this.scene);
        this.playSound('sounds/card_slide.mp3');

        this.updatePlayerUI();
        if (wasAceSplit && !this.config.rules.hitSplitAces) {
            hand1.isStanding = true;
            this.roundEndMessages.push(`Hand ${this.activeHandIndex + 1} (Split Ace) stands with ${hand1.score}.`);
        }
        this.updateButtonStates();
        this.uiUpdaters.displayMessage(`Split successful. Playing Hand ${this.activeHandIndex + 1}.`);
        if (hand1.isStanding && wasAceSplit && !this.config.rules.hitSplitAces) {
            if (this.playerHands.length > this.activeHandIndex + 1 &&
                this.playerHands[this.activeHandIndex + 1].isFromSplitAce &&
                !this.config.rules.hitSplitAces) {
                 this.playerHands[this.activeHandIndex + 1].isStanding = true;
                 this.roundEndMessages.push(`Hand ${this.activeHandIndex + 2} (Split Ace) stands with ${this.playerHands[this.activeHandIndex+1].score}.`);
            }
            this._advanceToNextPlayableHandOrDealer();
        }
    }
    canPlayerSurrender() { /* ... (no changes from previous state) ... */
        if (!this.config.rules.allowLateSurrender || this.isGameOver || this.askedInsurance) {
            return false;
        }
        if (this.playerHands.length === 1 && this.activeHandIndex === 0) {
            const hand = this.playerHands[0];
            if (hand.cards.length === 2 && !hand.isStanding && !hand.isBusted) {
                return true;
            }
        }
        return false;
    }
    playerSurrender() { /* ... (no changes from previous state) ... */
        if (!this.canPlayerSurrender()) {
            this.uiUpdaters.displayMessage("Cannot surrender at this time.");
            return;
        }
        const hand = this.playerHands[this.activeHandIndex];
        hand.isSurrendered = true;
        hand.isStanding = true;
        this.roundEndMessages.push(`Hand ${this.activeHandIndex + 1} surrendered. Half bet is forfeit.`);
        this.isPlayerTurn = false;
        this.endGame(false);
    }
    isBust(score) { return score > 21; }
}
