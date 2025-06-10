// js/deck.js (Client-Side Version)
"use strict";

class Card {
    constructor(suit, rank) {
        this.suit = suit;
        this.rank = rank;
        this.value = this._getValue();
        // faceTexturePath is primarily driven by server data if this class is used for anything.
        // createCardMesh in main.js now directly uses plain card objects from server
        // which should include faceTexturePath. This method is mostly for reference client-side.
        // this.faceTexturePath = this._getFaceTexturePath();
    }

    _getValue() {
        if (['Jack', 'Queen', 'King'].includes(this.rank)) {
            return 10;
        } else if (this.rank === 'Ace') {
            return 11;
        } else {
            return parseInt(this.rank);
        }
    }

    // This method might be primarily for reference if server sends full texture path
    // or if createCardMesh directly constructs path from rank/suit plain object.
    _getFaceTexturePath() {
        const rankFile = (this.rank === '10') ? 'T' : (this.rank.length > 1 ? this.rank.charAt(0).toUpperCase() : this.rank);
        const suitChar = this.suit.charAt(0).toUpperCase();
        return `textures/cards/faces/${rankFile}${suitChar}.png`;
    }

    toString() {
        return `${this.rank} of ${this.suit}`;
    }

    // toPlainObject() is primarily for server-side to prepare data for client.
    // Client-side Card instances might not need to call this if they are created from plain objects.
}

class Deck {
    constructor(numPacks = 1) {
        this.suits = ['Hearts', 'Diamonds', 'Clubs', 'Spades'];
        this.ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'Jack', 'Queen', 'King', 'Ace'];
        this.cards = [];
        // Client-side deck is not used for dealing logic in the multiplayer setup.
        // It's kept minimal here in case any client-side utility still needs it,
        // but likely it can be omitted from a final client build if main.js
        // exclusively uses card data from the server.
        // if (numPacks > 0) {
        //     // this.createDeck(numPacks); // Don't auto-create on client unless specifically needed
        // }
    }

    createDeck(numPacks = 1) {
        this.cards = [];
        for (let i = 0; i < numPacks; i++) {
            for (const suit of this.suits) {
                for (const rank of this.ranks) {
                    this.cards.push(new Card(suit, rank));
                }
            }
        }
    }

    shuffle() {
        for (let i = this.cards.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
        }
    }

    dealCard() {
        if (this.cards.length > 0) {
            return this.cards.pop();
        }
        return null;
    }
}

// Note: This client-side version of deck.js is significantly simplified
// as the authoritative deck and game logic now reside on the server.
// Its inclusion in a production client build should be evaluated based on actual usage
// in main.js (e.g., if main.js instantiates Card objects for some display purpose).
// Currently, main.js's createCardMesh takes plain objects from the server.
