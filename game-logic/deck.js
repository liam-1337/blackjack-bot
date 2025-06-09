// js/deck.js - Defines Card and Deck classes for a card game.

// Define standard suits and ranks for playing cards.
const SUITS = ["Hearts", "Diamonds", "Clubs", "Spades"];
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "Jack", "Queen", "King", "Ace"];

/**
 * Represents a single playing card.
 */
class Card {
    /**
     * Creates a card instance.
     * @param {string} suit - The suit of the card (e.g., "Hearts").
     * @param {string} rank - The rank of the card (e.g., "Ace", "10", "King").
     */
    constructor(suit, rank) {
        this.suit = suit;
        this.rank = rank;
        this.faceTexturePath = this._getFaceTexturePath();
    }

    /**
     * Generates the expected file path for the card's face texture.
     * Assumes a convention like "textures/cards/faces/AS.png" (Ace of Spades).
     * For Ten, it uses 'T' (e.g., "TS.png").
     * @returns {string} The path to the face texture.
     * @private
     */
    _getFaceTexturePath() {
        // Rank mapping: '2'..'9', 'T' (for 10), 'J', 'Q', 'K', 'A'
        let rankFile;
        if (this.rank === "10") {
            rankFile = "T";
        } else if (["Jack", "Queen", "King", "Ace"].includes(this.rank)) {
            rankFile = this.rank.charAt(0).toUpperCase();
        } else {
            rankFile = this.rank; // "2" through "9"
        }
        // Suit mapping: 'H', 'D', 'C', 'S'
        const suitChar = this.suit.charAt(0).toUpperCase();
        return `textures/cards/faces/${rankFile}${suitChar}.png`;
    }

    /**
     * Returns a string representation of the card.
     * @returns {string} e.g., "Ace of Spades".
     */
    toString() {
        return `${this.rank} of ${this.suit}`;
    }

    /**
     * Gets the Blackjack value of the card.
     * Face cards (Jack, Queen, King) are 10. Ace is 11 by default.
     * Numbered cards are their face value.
     * Note: Ace as 1 or 11 logic is handled by hand value calculation in Game.js.
     * @returns {number} The Blackjack value of the card.
     */
    getValue() {
        if (["Jack", "Queen", "King"].includes(this.rank)) {
            return 10;
        }
        if (this.rank === "Ace") {
            return 11; // Default Ace value
        }
        return parseInt(this.rank); // For ranks "2" through "10"
    }

    /**
     * Returns a plain object representation of the card, suitable for sending over network.
     * @returns {{rank: string, suit: string, value: number, texturePath: string}}
     */
    toPlainObject() {
        return {
            rank: this.rank,
            suit: this.suit,
            value: this.getValue(), // May not be needed by client if score is sent
            faceTexturePath: this.faceTexturePath // Client needs this for rendering
        };
    }
}

/**
 * Represents a deck of playing cards.
 */
class Deck {
    /**
     * Creates a new deck, optionally with multiple 52-card packs.
     * @param {number} [numPacks=1] - The number of standard 52-card packs to include in this deck.
     */
    constructor(numPacks = 1) { // numPacks will be used by createDeck
        this.cards = [];
        // this.numPacks = numPacks; // Store if needed, but createDeck will use its param
        this.createDeck(numPacks); // Pass numPacks to createDeck
        // Note: Shuffling is typically done after creation, e.g., in Game.js constructor.
    }

    /**
     * Populates the deck with cards from the specified number of packs.
     * Clears any existing cards before creating the new set.
     * @param {number} [numPacks=1] - The number of 52-card packs to create.
     */
    createDeck(numPacks = 1) { // Accepts numPacks parameter
        this.cards = [];
        for (let i = 0; i < numPacks; i++) { // Loop numPacks times
            for (const suit of SUITS) {
                for (const rank of RANKS) {
                    this.cards.push(new Card(suit, rank));
                }
            }
        }
    }

    /**
     * Shuffles the cards in the deck using the Fisher-Yates algorithm.
     */
    shuffle() {
        for (let i = this.cards.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]]; // Swap elements
        }
    }

    /**
     * Deals (removes and returns) the top card from the deck.
     * @returns {Card|null} The card dealt, or null if the deck is empty.
     */
    dealCard() {
        if (this.cards.length === 0) {
            console.warn("Deck is empty! Cannot deal card.");
            // In a real game, might trigger reshuffle of a discard pile or end game.
            return null;
        }
        return this.cards.pop();
    }

    /**
     * Returns the number of cards currently remaining in the deck.
     * @returns {number} The count of remaining cards.
     */
    cardsRemaining() {
        return this.cards.length;
    }

    /**
     * Checks if the deck has at least a certain number of cards remaining.
     * @param {number} count - The number of cards to check for.
     * @returns {boolean} True if there are enough cards, false otherwise.
     */
    hasEnoughCards(count) {
        return this.cards.length >= count;
    }
}

module.exports = { Card, Deck };
