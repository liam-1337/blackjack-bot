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
}

/**
 * Represents a deck of playing cards.
 */
class Deck {
    /**
     * Creates a new deck, optionally with multiple 52-card packs.
     * @param {number} [numPacks=1] - The number of standard 52-card packs to include in this deck.
     */
    constructor(numPacks = 1) {
        this.cards = [];        // Array to hold the Card objects
        this.numPacks = numPacks; // Number of 52-card packs
        this.createDeck();      // Initialize with cards
    }

    /**
     * Populates the deck with cards from the specified number of packs.
     * Clears any existing cards before creating the new set.
     */
    createDeck() {
        this.cards = [];
        for (let i = 0; i < this.numPacks; i++) {
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
        return this.cards.pop(); // Remove and return the last card (top of the deck)
    }
}
