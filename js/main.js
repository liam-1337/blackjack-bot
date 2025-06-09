// js/main.js - Main script for Three.js scene setup, game initialization, and UI event handling.

// --- Constants ---

// Chip visual properties
const CHIP_RADIUS = 0.2;
const CHIP_HEIGHT = 0.05;
const CHIP_VALUES_COLORS = {
    1: 0xffffff,    // White
    5: 0xff0000,    // Red
    10: 0x0000ff,   // Blue
    25: 0x00ff00,   // Green
    100: 0x000000,  // Black
};

// Card visual properties
const CARD_WIDTH = 0.7;
const CARD_HEIGHT = 1;
const CARD_DEPTH = 0.05;

// Table visual properties
const TABLE_RADIUS = 2.8;
const TABLE_THICKNESS = 0.2;
const TABLE_Y_SURFACE = -1.0;   // Y position of the TOP surface of the table

// Betting Area visual properties
const BETTING_AREA_RADIUS = 0.4;
const BETTING_AREA_THICKNESS = 0.01;
const BETTING_AREA_Y = TABLE_Y_SURFACE + BETTING_AREA_THICKNESS / 2 + 0.005;

// Placeholder visual properties (can be removed if game objects are sufficient)
const PLAYER_SPHERE_RADIUS = 0.3;
const DEALER_SPHERE_RADIUS = 0.3;

// Animation & Sound constants
const DEAL_START_POSITION = new THREE.Vector3(0, TABLE_Y_SURFACE + 0.7, -0.5); // Start deal from above table, dealer side
const CARD_ANIMATION_SPEED = 0.08;

// Global constant for card Y position on table (used by Game.js if passed, or Game.js uses its own)
const CARD_Y_ON_TABLE = TABLE_Y_SURFACE + CARD_DEPTH / 2 + 0.01;


// --- Utility Functions ---

/**
 * Creates a 3D mesh for a poker chip.
 * @param {number} x - The x-coordinate.
 * @param {number} y - The y-coordinate.
 * @param {number} z - The z-coordinate.
 * @param {number} value - The chip's denomination value (determines color).
 * @returns {THREE.Mesh} The chip mesh.
 */
function createChipMesh(x, y, z, value) {
    const geometry = new THREE.CylinderGeometry(CHIP_RADIUS, CHIP_RADIUS, CHIP_HEIGHT, 32);
    const color = CHIP_VALUES_COLORS[value] || 0x808080;
    const material = new THREE.MeshStandardMaterial({ color: color });
    const chipMesh = new THREE.Mesh(geometry, material);
    chipMesh.position.set(x, y, z);
    return chipMesh;
}

/**
 * Creates a 3D mesh for a playing card.
 * @param {number} x - The target x-coordinate (used if not animated, or as target).
 * @param {number} y - The target y-coordinate.
 * @param {number} z - The target z-coordinate.
 * @returns {THREE.Mesh} The card mesh.
 */
function createCardMesh(x, y, z) {
    const geometry = new THREE.BoxGeometry(CARD_WIDTH, CARD_HEIGHT, CARD_DEPTH);
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const cardMesh = new THREE.Mesh(geometry, material);
    // Initial position is set by animation or directly if no animation.
    // cardMesh.position.set(x, y, z);
    return cardMesh;
}

/**
 * Initiates animation for a card mesh to a target position.
 * @param {THREE.Mesh} cardMesh - The card mesh to animate.
 * @param {THREE.Vector3} targetPosition - The destination position.
 * @param {THREE.Scene} sceneRef - Reference to the scene to add the card.
 */
function initiateCardAnimation(cardMesh, targetPosition, sceneRef) {
    cardMesh.position.copy(DEAL_START_POSITION);
    sceneRef.add(cardMesh);
    animatedObjects.push({
        mesh: cardMesh,
        target: new THREE.Vector3().copy(targetPosition),
        isAnimating: true,
        speed: CARD_ANIMATION_SPEED
    });
}

/**
 * Plays a sound effect.
 * @param {string} soundPath - Path to the sound file.
 */
function playSound(soundPath) {
    const audio = new Audio(soundPath);
    audio.play().catch(error => console.warn(`Error playing sound ${soundPath}:`, error));
}


// --- Scene Setup ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101020);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer();
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// Camera setup
camera.position.set(0, 2, 4); // Positioned to view the table
camera.lookAt(0, TABLE_Y_SURFACE + 0.3, 0); // Look at a point slightly above the table center

// Lighting setup
const ambientLight = new THREE.AmbientLight(0x606060);
scene.add(ambientLight);
const directionalLight = new THREE.DirectionalLight(0xffffff, 0.7);
directionalLight.position.set(1, 3, 2);
scene.add(directionalLight);

// Table setup
const tableGeometry = new THREE.CylinderGeometry(TABLE_RADIUS, TABLE_RADIUS, TABLE_THICKNESS, 64);
const tableMaterial = new THREE.MeshStandardMaterial({ color: 0x005000 });
const tableMesh = new THREE.Mesh(tableGeometry, tableMaterial);
tableMesh.position.y = TABLE_Y_SURFACE - (TABLE_THICKNESS / 2);
scene.add(tableMesh);
directionalLight.target = tableMesh; // Light focuses on the table

// Betting Area setup
const bettingAreaGeometry = new THREE.CylinderGeometry(BETTING_AREA_RADIUS, BETTING_AREA_RADIUS, BETTING_AREA_THICKNESS, 64);
const bettingAreaMaterial = new THREE.MeshStandardMaterial({ color: 0x222222, transparent: true, opacity: 0.6 });
const bettingAreaMesh = new THREE.Mesh(bettingAreaGeometry, bettingAreaMaterial);
bettingAreaMesh.position.set(0, BETTING_AREA_Y, 0.7);
scene.add(bettingAreaMesh);

// Player and Dealer Placeholder Meshes (optional, for visual reference)
const playerGeometry = new THREE.SphereGeometry(PLAYER_SPHERE_RADIUS, 32, 32);
const playerMaterial = new THREE.MeshStandardMaterial({ color: 0x3333ff, transparent: true, opacity: 0.3 });
const playerPlaceholder = new THREE.Mesh(playerGeometry, playerMaterial);
playerPlaceholder.position.set(0, TABLE_Y_SURFACE + PLAYER_SPHERE_RADIUS, 1.8);
scene.add(playerPlaceholder);

const dealerGeometry = new THREE.SphereGeometry(DEALER_SPHERE_RADIUS, 32, 32);
const dealerMaterial = new THREE.MeshStandardMaterial({ color: 0xff3333, transparent: true, opacity: 0.3 });
const dealerPlaceholder = new THREE.Mesh(dealerGeometry, dealerMaterial);
dealerPlaceholder.position.set(0, TABLE_Y_SURFACE + DEALER_SPHERE_RADIUS, -1.5);
scene.add(dealerPlaceholder);


// --- Animation System ---
const animatedObjects = []; // Stores objects like { mesh, target, isAnimating, speed }

/**
 * Main animation loop called by requestAnimationFrame.
 */
function animate() {
    requestAnimationFrame(animate);
    // Process object animations
    for (let i = animatedObjects.length - 1; i >= 0; i--) {
        const obj = animatedObjects[i];
        if (obj.isAnimating) {
            obj.mesh.position.lerp(obj.target, obj.speed);
            if (obj.mesh.position.distanceTo(obj.target) < 0.01) {
                obj.mesh.position.copy(obj.target);
                obj.isAnimating = false;
                // Consider removing finished animations if they won't be reused:
                // animatedObjects.splice(i, 1);
            }
        }
    }
    renderer.render(scene, camera);
}
animate(); // Start the animation loop


// --- UI Elements and Event Handlers ---

// Get references to all UI elements involved in game interaction
const playerCardsSpan = document.getElementById('player-cards');
const playerValueSpan = document.getElementById('player-value');
const dealerCardsSpan = document.getElementById('dealer-cards');
const dealerValueSpan = document.getElementById('dealer-value');
const betAmountSpan = document.getElementById('bet-amount');
const gameMessageSpan = document.getElementById('game-message');
const hitButton = document.getElementById('hit-button');
const standButton = document.getElementById('stand-button');
const doubleButton = document.getElementById('double-button');
const splitButton = document.getElementById('split-button');
const newGameButton = document.getElementById('new-game-button');
// Insurance UI elements
const insurancePromptDiv = document.getElementById('insurance-prompt');
const insuranceCostTextSpan = document.getElementById('insurance-cost-text');
const takeInsuranceButton = document.getElementById('take-insurance-button');
const declineInsuranceButton = document.getElementById('decline-insurance-button');
const insuranceBetInfoDiv = document.getElementById('insurance-bet-info');
const insuranceBetAmountSpan = document.getElementById('insurance-bet-amount');

// UI Update Functions to pass to Game
const uiUpdaters = {
    updatePlayer: (handsData) => {
        let playerHTML = "";
        if (handsData && handsData.length > 0) {
            handsData.forEach((hand, index) => {
                playerHTML += `<div class="hand ${hand.isActive ? 'active-hand' : ''}">`;
                playerHTML += `<h3>Hand ${index + 1} ${hand.isActive ? '(Active)' : ''}</h3>`;
                playerHTML += `<p>Cards: ${hand.cardsString}</p>`;
                playerHTML += `<p>Score: ${hand.score} ${hand.isBusted ? '(Bust)' : ''}</p>`;
                playerHTML += `<p>Bet: ${hand.bet}</p>`;
                if(hand.isStanding) playerHTML += `<p>(Standing)</p>`;
                playerHTML += `</div>`;
            });
        } else {
            playerHTML = "<p>Hand: <span id=\"player-cards\"></span></p><p>Value: <span id=\"player-value\"></span></p>";
        }
        document.getElementById('player-info').innerHTML = playerHTML.includes("<h3>") ? playerHTML : `<h2>Player</h2>${playerHTML}`;
    },
    updateDealer: (handString, score) => {
        dealerCardsSpan.textContent = handString;
        dealerValueSpan.textContent = score;
    },
    updateBet: (amount) => {
        betAmountSpan.textContent = amount;
    },
    displayMessage: (message) => {
        gameMessageSpan.innerHTML = message;
    },
    updateButtons: ({ canHit, canStand, canDouble, canSplit, showNewGame }) => {
        hitButton.disabled = !canHit;
        standButton.disabled = !canStand;
        doubleButton.disabled = !canDouble;
        splitButton.disabled = !canSplit;

        hitButton.style.display = showNewGame ? 'none' : 'inline-block';
        standButton.style.display = showNewGame ? 'none' : 'inline-block';
        doubleButton.style.display = showNewGame ? 'none' : 'inline-block';
        splitButton.style.display = showNewGame ? 'none' : 'inline-block';
        newGameButton.style.display = showNewGame ? 'inline-block' : 'none';
    },
    promptInsurance: (cost) => {
        insuranceCostTextSpan.textContent = cost;
        insurancePromptDiv.style.display = 'block';
    },
    hideInsurancePrompt: () => {
        insurancePromptDiv.style.display = 'none';
    },
    updateInsuranceBetDisplay: (amount) => {
        insuranceBetAmountSpan.textContent = amount;
        insuranceBetInfoDiv.style.display = 'block';
    },
    hideInsuranceBetDisplay: () => {
        insuranceBetInfoDiv.style.display = 'none';
    }
};

// --- Game Initialization ---
const game = new Game(
    scene,
    CARD_WIDTH,
    createChipMesh,
    CHIP_VALUES_COLORS,
    CHIP_HEIGHT,
    uiUpdaters,
    createCardMesh,
    initiateCardAnimation,
    playSound
    // CARD_Y_ON_TABLE could be passed here if Game.js didn't define its own TARGET_CARD_Y_ON_TABLE
);
console.log("Blackjack game object created.");

// --- Event Listeners ---
hitButton.addEventListener('click', () => { if (game) game.playerHit(); });
standButton.addEventListener('click', () => { if (game) game.playerStand(); });
doubleButton.addEventListener('click', () => { if (game) game.playerDoubleDown(); });
splitButton.addEventListener('click', () => { if (game) game.playerSplit(); });
takeInsuranceButton.addEventListener('click', () => { if (game) game.playerTakesInsurance(); });
declineInsuranceButton.addEventListener('click', () => { if (game) game.playerDeclinesInsurance(); });

newGameButton.addEventListener('click', () => {
    // Reset player UI to default single-hand display
    document.getElementById('player-info').innerHTML = '<h2>Player</h2><p>Hand: <span id="player-cards"></span></p><p>Value: <span id="player-value"></span></p>';
    // Hide any persistent insurance UI elements
    uiUpdaters.hideInsuranceBetDisplay();
    uiUpdaters.hideInsurancePrompt();
    // Start a new game with a default bet
    uiUpdaters.displayMessage("New game started. Default bet is 36.");
    game.startGame(36);
});

// Set initial UI state (only "New Game" button active)
uiUpdaters.updateButtons({canHit: false, canStand: false, canDouble: false, canSplit: false, showNewGame: true});
