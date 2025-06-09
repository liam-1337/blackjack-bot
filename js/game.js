// js/game.js - Core Blackjack game logic.

// Y position for cards when they are on the table.
// Derived from main.js: TABLE_Y_SURFACE (-1.0) + CARD_DEPTH (0.05)/2 + epsilon (0.01) = -0.965
const TARGET_CARD_Y_ON_TABLE = -0.965;

class Game {
    /**
     * Initializes a new Blackjack game instance.
     * @param {THREE.Scene} scene - The Three.js scene object.
     * @param {number} cardWidth - Visual width of a card.
     * @param {function} createChipMeshFn - Function to create 3D chip meshes.
     * @param {object} chipValuesColors - Mapping of chip values to colors.
     * @param {number} chipHeight - Visual height of a chip.
     * @param {object} uiUpdaters - Object containing functions to update HTML UI elements.
     * @param {function} createCardMeshFn - Function to create 3D card meshes.
     * @param {function} initiateCardAnimationFn - Function to animate card dealing.
     * @param {function} playSoundFn - Function to play sound effects.
     */
    constructor(scene, cardWidth, createChipMeshFn, chipValuesColors, chipHeight, uiUpdaters, createCardMeshFn, initiateCardAnimationFn, playSoundFn) {
        this.scene = scene;
        this.cardWidth = cardWidth;
        this.createChipMesh = createChipMeshFn;
        this.createCardMesh = createCardMeshFn;
        this.initiateCardAnimation = initiateCardAnimationFn;
        this.playSound = playSoundFn;
        this.chipValuesColors = chipValuesColors;
        this.chipHeight = chipHeight;
        this.uiUpdaters = uiUpdaters;

        this.deck = new Deck(); // Game uses its own Deck instance
        // Game state variables
        this.playerHands = [];
        this.activeHandIndex = 0; // Index of the current player hand being played (for splits)
        this.dealerHand = [];
        this.dealerCardMeshes = []; // 3D meshes for dealer's cards

        this.totalPlayerBet = 0;  // Total amount bet by player across all hands
        this.currentBetChipMeshes = []; // 3D meshes for currently displayed bet chips

        this.isPlayerTurn = false;
        this.isGameOver = false;
        this.dealerScore = 0; // Dealer's hand score

        // Insurance specific state
        this.insuranceBetAmount = 0;
        this.askedInsurance = false;   // Flag if insurance has been offered this round
        this.insuranceResolved = false; // Flag if insurance outcome has been determined for the round
        this.roundEndMessages = []; // Accumulates messages for display at round end
    }

    /**
     * Creates a new player hand object.
     * @param {number} initialBet - The bet amount for this hand.
     * @returns {object} A player hand object.
     */
    _createPlayerHand(initialBet = 0) {
        return {
            cards: [], score: 0, bet: initialBet,
            isStanding: false, isBusted: false,
            cardMeshes: [], isDoubled: false
        };
    }

    /**
     * Clears all bets (chips and amounts) and resets insurance state.
     * Called at the start of a new game.
     */
    clearBet() {
        this.currentBetChipMeshes.forEach(mesh => { if (mesh && this.scene) this.scene.remove(mesh); });
        this.currentBetChipMeshes = [];
        this.totalPlayerBet = 0;
        this.playerHands.forEach(hand => hand.bet = 0);

        this.insuranceBetAmount = 0;
        this.askedInsurance = false;
        this.insuranceResolved = false;
        if (this.uiUpdaters.hideInsuranceBetDisplay) this.uiUpdaters.hideInsuranceBetDisplay();
    }

    /**
     * Displays 3D chips corresponding to the total bet amount.
     * Clears existing bet chips before displaying new ones.
     * @param {number} totalBetAmount - The total amount to display as chips.
     */
    displayBetChips(totalBetAmount) {
        this.currentBetChipMeshes.forEach(mesh => { if (mesh && this.scene) this.scene.remove(mesh); });
        this.currentBetChipMeshes = [];
        this.totalPlayerBet = totalBetAmount;
        console.log(`Displaying chips for total bet: ${totalBetAmount}`);

        const BETTING_AREA_X = 0;
        const BETTING_AREA_Z = 0.7;
        const BET_CHIP_Y_BASE = -0.99 + this.chipHeight / 2;

        let remainingAmount = totalBetAmount;
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
        if (remainingAmount > 0) console.warn("Could not make exact bet with available chip denominations.");
        this.uiUpdaters.updateBet(this.totalPlayerBet);
        if (totalBetAmount > 0) this.playSound('sounds/chip_place.mp3');
    }

    /**
     * Updates the player's UI elements (hand display, score).
     * This method prepares data for multiple hands if applicable.
     */
    updatePlayerUI() {
        const handsData = this.playerHands.map((hand, index) => ({
            cardsString: hand.cards.map(card => card.toString()).join(', '),
            score: hand.score, bet: hand.bet, isBusted: hand.isBusted,
            isStanding: hand.isStanding,
            isActive: index === this.activeHandIndex && !this.isGameOver && this.isPlayerTurn
        }));
        this.uiUpdaters.updatePlayer(handsData);
    }

    /**
     * Updates the dealer's UI elements (hand display, score).
     * @param {boolean} revealAll - If true, shows all dealer cards and actual score.
     *                              Otherwise, shows one card and "[Hidden Card]".
     */
    updateDealerUI(revealAll = false) {
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

    /**
     * Checks if the player can double down on the specified or active hand.
     * Conditions: Player's turn, game not over, hand has 2 cards, not already standing/busted/doubled.
     * @param {number} [handIndex=this.activeHandIndex] - The index of the hand to check.
     * @returns {boolean} True if player can double down on the hand.
     */
    canPlayerDoubleDown(handIndex = this.activeHandIndex) {
        const hand = this.playerHands[handIndex];
        return this.isPlayerTurn && !this.isGameOver && hand && hand.cards.length === 2 && !hand.isStanding && !hand.isBusted && !hand.isDoubled;
    }

    /**
     * Checks if the player can split their active hand.
     * Conditions: Player's turn, game not over, active hand has 2 cards of the same rank.
     *             Currently allows only one split overall (playerHands.length < 2).
     * @returns {boolean} True if player can split the active hand.
     */
    canPlayerSplit() {
        if (this.playerHands.length >= 2) return false;
        const hand = this.playerHands[this.activeHandIndex];
        if (!hand) return false;
        return this.isPlayerTurn && !this.isGameOver && hand.cards.length === 2 && hand.cards[0].rank === hand.cards[1].rank;
    }

    /**
     * Calculates the Blackjack score for an array of cards.
     * Aces are counted as 11 unless the total score exceeds 21, then they are counted as 1.
     * @param {Card[]} cardsArray - An array of Card objects.
     * @returns {number} The calculated score.
     */
    calculateHandValue(cardsArray) {
        let score = 0; let aceCount = 0;
        cardsArray.forEach(card => { score += card.getValue(); if (card.rank === "Ace") aceCount++; });
        while (score > 21 && aceCount > 0) { score -= 10; aceCount--; }
        return score;
    }

    /**
     * Starts a new game round.
     * Resets game state, deals initial cards, and handles initial Blackjack checks or offers insurance.
     * @param {number} [betAmount=10] - The initial bet amount for the first hand.
     */
    startGame(betAmount = 10) {
        this.clearBet();
        this.isPlayerTurn = true; this.isGameOver = false; this.activeHandIndex = 0;
        this.insuranceResolved = false; this.roundEndMessages = [];

        this.playerHands.forEach(h => h.cardMeshes.forEach(m => { if(m) this.scene.remove(m); }));
        const initialHand = this._createPlayerHand(betAmount);
        this.playerHands = [initialHand];
        this.totalPlayerBet = betAmount;
        this.displayBetChips(this.totalPlayerBet);

        this.dealerHand = [];
        this.dealerCardMeshes.forEach(m => { if(m) this.scene.remove(m); });
        this.dealerCardMeshes = [];

        this.deck = new Deck(); this.deck.shuffle();

        initialHand.cards.push(this.deck.dealCard(), this.deck.dealCard());
        this.dealerHand.push(this.deck.dealCard(), this.deck.dealCard());

        initialHand.score = this.calculateHandValue(initialHand.cards);
        this.dealerScore = this.calculateHandValue(this.dealerHand);

        this._setupInitialCardMeshes();
        console.log("---- GAME STARTED ----");
        this.updatePlayerUI();
        this.updateDealerUI(false);

        const playerHasBlackjack = initialHand.score === 21;
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

    /**
     * Sets up the 3D card meshes for the initial deal (player's first hand and dealer's hand).
     * Animates cards from DEAL_START_POSITION to their target positions.
     */
    _setupInitialCardMeshes() {
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
            const targetX = DEALER_BASE_X + (index * (this.cardWidth + 0.1));
            const cardMesh = this.createCardMesh(targetX, TARGET_CARD_Y_ON_TABLE, DEALER_Z);
            this.dealerCardMeshes.push(cardMesh);
            this.initiateCardAnimation(cardMesh, { x: targetX, y: TARGET_CARD_Y_ON_TABLE, z: DEALER_Z }, this.scene);
        });
        if (this.dealerHand.length > 0) this.playSound('sounds/card_slide.mp3');
    }

    /**
     * Updates the enabled/disabled state of action buttons in the UI based on current game state.
     * Calls the UI updater function passed from main.js.
     */
    updateButtonStates() {
        const currentHand = this.playerHands[this.activeHandIndex];
        const canHit = this.isPlayerTurn && !this.isGameOver && currentHand && !currentHand.isStanding && !currentHand.isBusted;
        const canStand = this.isPlayerTurn && !this.isGameOver && currentHand && !currentHand.isStanding && !currentHand.isBusted;
        const canDouble = canHit && currentHand.cards.length === 2 && !currentHand.isDoubled;
        const canSplit = this.canPlayerSplit();
        this.uiUpdaters.updateButtons({ canHit, canStand, canDouble, canSplit, showNewGame: false });
    }

    // --- Insurance Methods ---

    /**
     * Offers insurance to the player if the dealer's upcard is an Ace.
     * Shows the insurance prompt and disables main action buttons.
     */
    offerInsurance() {
        this.askedInsurance = true;
        const insuranceCost = this.totalPlayerBet / 2;
        this.uiUpdaters.promptInsurance(insuranceCost);
        this.uiUpdaters.updateButtons({ canHit: false, canStand: false, canDouble: false, canSplit: false, showNewGame: false });
        this.uiUpdaters.displayMessage("Dealer has an Ace. Insurance offered.");
    }

    /**
     * Handles the player's decision to take insurance.
     * Updates insurance bet amount, UI, and re-enables main actions.
     */
    playerTakesInsurance() {
        if (!this.askedInsurance) return;
        this.insuranceBetAmount = this.totalPlayerBet / 2;
        if (this.uiUpdaters.updateInsuranceBetDisplay) this.uiUpdaters.updateInsuranceBetDisplay(this.insuranceBetAmount);
        if (this.uiUpdaters.hideInsurancePrompt) this.uiUpdaters.hideInsurancePrompt();
        this.askedInsurance = false;
        this.playSound('sounds/chip_place.mp3');
        this.uiUpdaters.displayMessage(`Insurance taken for ${this.insuranceBetAmount}. Player's turn.`);
        this.updateButtonStates();
    }

    /**
     * Handles the player's decision to decline insurance.
     * Hides insurance prompt and re-enables main actions.
     */
    playerDeclinesInsurance() {
        if (!this.askedInsurance) return;
        if (this.uiUpdaters.hideInsurancePrompt) this.uiUpdaters.hideInsurancePrompt();
        this.askedInsurance = false;
        this.uiUpdaters.displayMessage("Insurance declined. Player's turn.");
        this.updateButtonStates();
    }

    /**
     * Resolves the insurance bet based on whether the dealer had a natural Blackjack.
     * Adds the outcome message to `roundEndMessages`.
     * @param {boolean} dealerHasNaturalBlackjack - True if dealer has a natural Blackjack.
     */
    resolveInsurance(dealerHasNaturalBlackjack) {
        if (this.insuranceBetAmount > 0 && !this.insuranceResolved) {
            let insuranceMessage = "";
            if (dealerHasNaturalBlackjack) {
                insuranceMessage = `Dealer has Natural Blackjack! Insurance PAYS ${this.insuranceBetAmount * 2}.`;
            } else {
                insuranceMessage = `Dealer does not have Natural Blackjack. Insurance lost (-${this.insuranceBetAmount}).`;
            }
            this.roundEndMessages.push(insuranceMessage);
            this.insuranceResolved = true;
        }
    }

    // --- Game Flow Methods ---

    /**
     * Ends the current game round.
     * Determines winner if not already decided by BJ/bust, resolves pending insurance,
     * updates UI with final messages and button states.
     * @param {boolean} [isBlackjackOrBust=false] - True if game ended due to BJ or player/dealer bust.
     */
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
        this.uiUpdaters.displayMessage(this.roundEndMessages.join("<br>"));
        this.uiUpdaters.updateButtons({ canHit: false, canStand: false, canDouble: false, canSplit: false, showNewGame: true });

        this.insuranceBetAmount = 0; this.askedInsurance = false; this.insuranceResolved = false;
        if (this.uiUpdaters.hideInsuranceBetDisplay) this.uiUpdaters.hideInsuranceBetDisplay();
    }

    // --- Player Action Methods ---

    /**
     * Handles the player's "Double Down" action for the active hand.
     * Doubles the bet, deals one more card, and the hand automatically stands.
     */
    playerDoubleDown() {
        const hand = this.playerHands[this.activeHandIndex];
        if (!this.canPlayerDoubleDown()) { this.uiUpdaters.displayMessage("Cannot Double Down now."); return; }
        this.uiUpdaters.displayMessage(`Hand ${this.activeHandIndex + 1} Doubles Down!`);
        this.totalPlayerBet += hand.bet; hand.bet *= 2; hand.isDoubled = true;
        this.displayBetChips(this.totalPlayerBet);

        hand.cards.push(this.deck.dealCard());
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
        this.playerStand();
    }

    /**
     * Handles the player's "Hit" action for the active hand.
     * Deals another card to the hand. If busted, the hand automatically stands.
     */
    playerHit() {
        const hand = this.playerHands[this.activeHandIndex];
        if (!this.isPlayerTurn || this.isGameOver || !hand || hand.isStanding || hand.isBusted) return;
        hand.cards.push(this.deck.dealCard());
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
            this.playerStand();
        } else {
             this.updateButtonStates();
        }
    }

    /**
     * Handles the player's "Stand" action for the active hand.
     * The hand is marked as standing. If there are more hands to play (from a split),
     * moves to the next hand. Otherwise, proceeds to the dealer's turn.
     */
    playerStand() {
        const hand = this.playerHands[this.activeHandIndex];
        if (!this.isPlayerTurn || this.isGameOver || !hand || hand.isBusted) { // Check if action is valid
             if (hand && hand.isStanding) { /* Already standing (e.g. after double), proceed */ }
             else if (!hand || hand.isBusted) { /* Hand is busted, proceed */ }
             else return; // Not standing or busted, but tried to stand when not allowed (should be rare with button logic)
        }

        if (hand && !hand.isStanding && !hand.isBusted) { // If hand is playable and now standing
            hand.isStanding = true;
            this.roundEndMessages.push(`Hand ${this.activeHandIndex + 1} stands with ${hand.score}.`);
        }

        // Attempt to move to the next hand or dealer's turn
        const nextHandIndex = this.activeHandIndex + 1;
        if (nextHandIndex < this.playerHands.length) {
            this.activeHandIndex = nextHandIndex;
            this.uiUpdaters.displayMessage(`Playing Hand ${this.activeHandIndex + 1}.`);
            this.updatePlayerUI(); this.updateButtonStates();
        } else {
            this.isPlayerTurn = false; // All player hands played
            this.dealerPlay();
        }
    }

    /**
     * Handles the dealer's turn.
     * Dealer reveals hidden card and hits according to standard rules (hits on soft 17 or less).
     * Animates dealt cards and updates UI.
     */
    dealerPlay() {
        if (this.playerHands.every(hand => hand.isBusted)) { // Skip dealer play if all player hands busted
            this.roundEndMessages.push("All player hands busted. Dealer wins.");
            this.endGame(true); return;
        }
        this.isPlayerTurn = false;
        this.uiUpdaters.updateButtons({ canHit: false, canStand: false, canDouble: false, canSplit: false, showNewGame: false });
        this.uiUpdaters.displayMessage("Dealer is playing...");
        this.dealerScore = this.calculateHandValue(this.dealerHand);
        this.updateDealerUI(true);

        const dealerActionInterval = setInterval(() => {
            if (this.dealerScore < 17) {
                this.uiUpdaters.displayMessage("Dealer hits.");
                const newCard = this.deck.dealCard(); this.dealerHand.push(newCard);
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
                    clearInterval(dealerActionInterval); this.endGame(true); // Game ends due to dealer bust
                    return;
                }
            } else {
                this.roundEndMessages.push(`Dealer stands with ${this.dealerScore}.`);
                clearInterval(dealerActionInterval); this.endGame(false); // Game ends, not due to bust
                return;
            }
        }, 1000);
    }

    /**
     * Determines the winner(s) for each player hand against the dealer's hand.
     * Populates `roundEndMessages` with the outcomes. Called by `endGame`.
     */
    determineWinner() {
        this.playerHands.forEach((hand, index) => {
            let handMessage = `Hand ${index + 1} (${hand.score}): `; // Display score of the hand
            if (hand.isBusted) handMessage += "Busted."; // Player hand specific bust message
            else if (this.dealerScore > 21) handMessage += "Dealer busted. Player wins!";
            else if (hand.score > this.dealerScore) handMessage += `Wins vs Dealer (${this.dealerScore})!`;
            else if (this.dealerScore > hand.score) handMessage += `Loses vs Dealer (${this.dealerScore}).`;
            else handMessage += `Push vs Dealer (${this.dealerScore}).`;
            this.roundEndMessages.push(handMessage);
        });
    }

    /**
     * Utility method to check if a score is a bust (over 21).
     * @param {number} score - The score to check.
     * @returns {boolean} True if the score is a bust.
     */
    isBust(score) { return score > 21; }

    /**
     * Handles the player's "Split" action for the active hand.
     * If allowed, creates a new hand, deals cards, updates bets and UI.
     * Player then plays the first split hand.
     */
    playerSplit() {
        if (!this.canPlayerSplit()) {
            this.uiUpdaters.displayMessage("Cannot split now.");
            this.updateButtonStates();
            return;
        }
        this.uiUpdaters.displayMessage("Player splits!");
        const hand1 = this.playerHands[this.activeHandIndex];
        const hand2 = this._createPlayerHand(hand1.bet);
        this.totalPlayerBet += hand1.bet;
        this.displayBetChips(this.totalPlayerBet);
        hand2.cards.push(hand1.cards.pop());
        this.playerHands.splice(this.activeHandIndex + 1, 0, hand2);
        hand1.cards.push(this.deck.dealCard());
        hand2.cards.push(this.deck.dealCard());
        hand1.score = this.calculateHandValue(hand1.cards);
        hand2.score = this.calculateHandValue(hand2.cards);

        // --- Update 3D card meshes ---
        if (hand1.cardMeshes.length > 0) {
            const meshToMove = hand1.cardMeshes.pop();
            hand2.cardMeshes.push(meshToMove);
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
        // --- End Update 3D card meshes ---

        this.updatePlayerUI();
        this.updateButtonStates();
        this.uiUpdaters.displayMessage(`Split successful. Playing Hand ${this.activeHandIndex + 1}.`);
    }
}
