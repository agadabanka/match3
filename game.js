/**
 * Match-3 (Bejeweled-style) — TypeScript IL game spec using @engine SDK.
 *
 * 8x8 grid with 6 gem types. Select a gem, then choose a direction
 * to swap with its neighbor. Matches of 3+ in a row/column are cleared,
 * gems fall via gravity, and cascades multiply the score.
 *
 * AI evaluates all possible swaps and simulates cascades to pick the
 * highest-scoring move. In playerVsAi mode the AI is disabled and the
 * player controls the board directly.
 */

import { defineGame } from '@engine/core';
import { pickBestMove } from '@engine/ai';
import { consumeAction } from '@engine/input';
import {
  findMatches, removeMatches, applyGravity,
  fillEmpty, isValidSwap, hasValidMoves,
} from '@engine/match';
import {
  clearCanvas, drawRoundedRect, drawLabel, drawGameOver,
} from '@engine/render';
import { drawTouchOverlay } from '@engine/touch';

// ── Constants ───────────────────────────────────────────────────────

const ROWS = 8;
const COLS = 8;
const CELL = 56;
const GAP = 3;
const MARGIN = 16;
const BOARD_W = COLS * (CELL + GAP) + GAP;
const BOARD_H = ROWS * (CELL + GAP) + GAP;

const GEM_TYPES = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];
const GEM_COLORS = {
  red:    '#E53935',
  orange: '#FB8C00',
  yellow: '#FDD835',
  green:  '#43A047',
  blue:   '#1E88E5',
  purple: '#8E24AA',
};
const GEM_BORDERS = {
  red:    '#B71C1C',
  orange: '#E65100',
  yellow: '#F9A825',
  green:  '#1B5E20',
  blue:   '#0D47A1',
  purple: '#4A148C',
};

const SCORE_PER_GEM = 10;
const CASCADE_MULTIPLIER = 2;
const AI_DELAY = 400;
const MATCH_FLASH_TIME = 200;
const SWAP_ANIM_TIME = 150;

// Direction offsets: [dr, dc]
const DIR_MAP = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] };

// ── Game Definition ─────────────────────────────────────────────────

const game = defineGame({
  display: {
    type: 'custom',
    width: COLS,
    height: ROWS,
    cellSize: CELL,
    canvasWidth: BOARD_W + MARGIN * 2 + 150,
    canvasHeight: BOARD_H + MARGIN * 2 + 50,
    offsetX: MARGIN,
    offsetY: MARGIN + 30,
    background: '#1a1a2e',
  },
  input: {
    up:      { keys: ['ArrowUp', 'w'] },
    down:    { keys: ['ArrowDown', 's'] },
    left:    { keys: ['ArrowLeft', 'a'] },
    right:   { keys: ['ArrowRight', 'd'] },
    select:  { keys: [' ', 'Enter'] },
    restart: { keys: ['r', 'R'] },
  },
});

// ── Resources ───────────────────────────────────────────────────────

game.resource('state', {
  score: 0,
  gameOver: false,
  moveCount: 0,
  combo: 0,
  message: 'Select a gem',
  phase: 'idle', // idle | selected | swapping | matching | cascading
});

game.resource('board', {
  grid: new Array(ROWS * COLS).fill(null),
  initialized: false,
  flashCells: [],     // cells currently flashing (match highlight)
  flashTimer: 0,
});

game.resource('_cursor', { r: 0, c: 0 });
game.resource('_selected', { r: -1, c: -1, active: false });
game.resource('_aiTimer', { elapsed: 0 });
game.resource('_anim', { timer: 0 });

// ── Helpers ─────────────────────────────────────────────────────────

function idx(r, c) { return r * COLS + c; }

function inBounds(r, c) {
  return r >= 0 && r < ROWS && c >= 0 && c < COLS;
}

function cloneGrid(grid) { return [...grid]; }

/** Generate a board with no pre-existing matches. */
function generateBoard(grid) {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      let gem;
      do {
        gem = GEM_TYPES[Math.floor(Math.random() * GEM_TYPES.length)];
      } while (createsMatch(grid, r, c, gem));
      grid[idx(r, c)] = gem;
    }
  }
}

/** Check if placing gem at (r,c) creates a 3-in-a-row looking left/up. */
function createsMatch(grid, r, c, gem) {
  // Horizontal: two to the left
  if (c >= 2 && grid[idx(r, c - 1)] === gem && grid[idx(r, c - 2)] === gem) return true;
  // Vertical: two above
  if (r >= 2 && grid[idx(r - 1, c)] === gem && grid[idx(r - 2, c)] === gem) return true;
  return false;
}

/** Simulate a full cascade chain on a grid clone. Returns total gems cleared. */
function simulateCascade(grid, rows, cols) {
  const sim = cloneGrid(grid);
  let totalCleared = 0;
  let cascadeLevel = 0;
  let matches = findMatches(sim, rows, cols);
  while (matches.length > 0) {
    const cleared = removeMatches(sim, cols, matches);
    totalCleared += cleared * (cascadeLevel + 1);
    cascadeLevel++;
    applyGravity(sim, rows, cols);
    fillEmpty(sim, rows, cols, GEM_TYPES);
    matches = findMatches(sim, rows, cols);
  }
  return totalCleared;
}

// ── Board Init System ───────────────────────────────────────────────

game.system('boardInit', function boardInitSystem(world, _dt) {
  const board = world.getResource('board');
  if (board.initialized) return;
  board.initialized = true;
  generateBoard(board.grid);
});

// ── Player Input System ─────────────────────────────────────────────

game.system('playerInput', function playerInputSystem(world, _dt) {
  const gm = world.getResource('gameMode');
  if (!gm || gm.mode !== 'playerVsAi') return;

  const state = world.getResource('state');
  if (state.gameOver || state.phase === 'matching' || state.phase === 'cascading' || state.phase === 'swapping') return;

  const input = world.getResource('input');
  const cursor = world.getResource('_cursor');
  const sel = world.getResource('_selected');
  const board = world.getResource('board');

  // Cursor movement
  if (consumeAction(input, 'up') && cursor.r > 0) cursor.r--;
  if (consumeAction(input, 'down') && cursor.r < ROWS - 1) cursor.r++;
  if (consumeAction(input, 'left') && cursor.c > 0) cursor.c--;
  if (consumeAction(input, 'right') && cursor.c < COLS - 1) cursor.c++;

  // Select / swap
  if (consumeAction(input, 'select')) {
    if (state.phase === 'idle') {
      // Select the gem under cursor
      sel.r = cursor.r;
      sel.c = cursor.c;
      sel.active = true;
      state.phase = 'selected';
      state.message = 'Pick direction to swap';
    } else if (state.phase === 'selected') {
      // Second press: determine swap direction from cursor vs selected
      const dr = cursor.r - sel.r;
      const dc = cursor.c - sel.c;

      // Must be adjacent (manhattan distance 1)
      if (Math.abs(dr) + Math.abs(dc) === 1) {
        attemptSwap(board, state, sel.r, sel.c, cursor.r, cursor.c);
      } else if (cursor.r === sel.r && cursor.c === sel.c) {
        // Deselect
        sel.active = false;
        state.phase = 'idle';
        state.message = 'Select a gem';
      } else {
        // Select a new gem instead
        sel.r = cursor.r;
        sel.c = cursor.c;
        state.message = 'Pick direction to swap';
      }
    }
  }

  // Direction shortcuts while in selected state
  if (state.phase === 'selected') {
    for (const [dirName, [dr, dc]] of Object.entries(DIR_MAP)) {
      if (dirName === 'up' || dirName === 'down') continue; // handled by cursor
      // Direction swaps via explicit action only in selected mode handled above
    }
  }
});

function attemptSwap(board, state, r1, c1, r2, c2) {
  const grid = board.grid;
  if (!isValidSwap(grid, ROWS, COLS, r1, c1, r2, c2)) {
    state.message = 'No match — invalid swap!';
    state.phase = 'idle';
    const sel2 = { r: -1, c: -1, active: false };
    // Reset selection in-place isn't possible here, caller must handle
    return;
  }

  // Perform the swap
  const i = idx(r1, c1);
  const j = idx(r2, c2);
  const tmp = grid[i];
  grid[i] = grid[j];
  grid[j] = tmp;

  state.moveCount++;
  state.combo = 0;
  state.phase = 'matching';
  state.message = 'Matching...';
}

// ── Cascade / Matching System ───────────────────────────────────────

game.system('cascade', function cascadeSystem(world, dt) {
  const state = world.getResource('state');
  if (state.phase !== 'matching' && state.phase !== 'cascading') return;

  const board = world.getResource('board');
  const anim = world.getResource('_anim');

  // Flash timer for matched cells
  if (board.flashCells.length > 0) {
    board.flashTimer -= dt;
    if (board.flashTimer > 0) return;

    // Remove flashed cells
    removeMatches(board.grid, COLS, [{ cells: board.flashCells }]);
    board.flashCells = [];

    // Apply gravity
    applyGravity(board.grid, ROWS, COLS);
    fillEmpty(board.grid, ROWS, COLS, GEM_TYPES);

    // Check for further cascades
    const nextMatches = findMatches(board.grid, ROWS, COLS);
    if (nextMatches.length > 0) {
      state.combo++;
      state.phase = 'cascading';
      startMatchFlash(board, state, nextMatches);
    } else {
      finishTurn(world);
    }
    return;
  }

  // Start of matching: find initial matches
  const matches = findMatches(board.grid, ROWS, COLS);
  if (matches.length > 0) {
    startMatchFlash(board, state, matches);
  } else {
    finishTurn(world);
  }
});

function startMatchFlash(board, state, matches) {
  // Collect unique cells to flash
  const seen = new Set();
  const cells = [];
  for (const match of matches) {
    for (const cell of match.cells) {
      const key = cell.r * COLS + cell.c;
      if (!seen.has(key)) {
        seen.add(key);
        cells.push(cell);
      }
    }
  }

  // Score: SCORE_PER_GEM per gem * cascade multiplier
  const multiplier = Math.pow(CASCADE_MULTIPLIER, state.combo);
  state.score += cells.length * SCORE_PER_GEM * multiplier;
  state.message = state.combo > 0
    ? `Cascade x${state.combo + 1}! +${cells.length * SCORE_PER_GEM * multiplier}`
    : `Matched ${cells.length} gems!`;

  board.flashCells = cells;
  board.flashTimer = MATCH_FLASH_TIME;
}

function finishTurn(world) {
  const state = world.getResource('state');
  const board = world.getResource('board');
  const sel = world.getResource('_selected');

  sel.active = false;
  sel.r = -1;
  sel.c = -1;

  if (!hasValidMoves(board.grid, ROWS, COLS)) {
    state.gameOver = true;
    state.message = 'No more valid moves!';
    state.phase = 'idle';
  } else {
    state.phase = 'idle';
    state.message = 'Select a gem';
  }
}

// ── AI System ───────────────────────────────────────────────────────

game.system('ai', function aiSystem(world, dt) {
  const gm = world.getResource('gameMode');
  if (gm && gm.mode === 'playerVsAi') return;

  const state = world.getResource('state');
  if (state.gameOver) return;
  if (state.phase !== 'idle') return;

  const timer = world.getResource('_aiTimer');
  timer.elapsed += dt;
  if (timer.elapsed < AI_DELAY) return;
  timer.elapsed = 0;

  const board = world.getResource('board');
  const grid = board.grid;

  // Evaluate all possible swaps
  const candidates = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      // Right swap
      if (c + 1 < COLS && isValidSwap(grid, ROWS, COLS, r, c, r, c + 1)) {
        const sim = cloneGrid(grid);
        const i = idx(r, c), j = idx(r, c + 1);
        const tmp = sim[i]; sim[i] = sim[j]; sim[j] = tmp;
        const score = simulateCascade(sim, ROWS, COLS);
        candidates.push({ r1: r, c1: c, r2: r, c2: c + 1, score });
      }
      // Down swap
      if (r + 1 < ROWS && isValidSwap(grid, ROWS, COLS, r, c, r + 1, c)) {
        const sim = cloneGrid(grid);
        const i = idx(r, c), j = idx(r + 1, c);
        const tmp = sim[i]; sim[i] = sim[j]; sim[j] = tmp;
        const score = simulateCascade(sim, ROWS, COLS);
        candidates.push({ r1: r, c1: c, r2: r + 1, c2: c, score });
      }
    }
  }

  if (candidates.length === 0) {
    state.gameOver = true;
    state.message = 'No more valid moves!';
    return;
  }

  const best = pickBestMove(candidates, m => m.score);

  // Perform the swap
  const i = idx(best.r1, best.c1);
  const j = idx(best.r2, best.c2);
  const tmp = grid[i]; grid[i] = grid[j]; grid[j] = tmp;

  state.moveCount++;
  state.combo = 0;
  state.phase = 'matching';
  state.message = 'Matching...';
});

// ── Render System ───────────────────────────────────────────────────

game.system('render', function renderSystem(world, _dt) {
  const renderer = world.getResource('renderer');
  if (!renderer) return;

  const { ctx } = renderer;
  const state = world.getResource('state');
  const board = world.getResource('board');
  const cursor = world.getResource('_cursor');
  const sel = world.getResource('_selected');
  const ox = MARGIN;
  const oy = MARGIN + 30;

  clearCanvas(ctx, '#1a1a2e');

  // Title
  drawLabel(ctx, 'MATCH-3', ox, oy - 10, { color: '#fff', fontSize: 20 });

  // Board background
  drawRoundedRect(ctx, ox, oy, BOARD_W, BOARD_H, 10, '#16213e', {
    strokeColor: '#0f3460', strokeWidth: 2,
  });

  // Build flash set for quick lookup
  const flashSet = new Set();
  for (const cell of board.flashCells) {
    flashSet.add(cell.r * COLS + cell.c);
  }

  // Draw gems
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const gem = board.grid[idx(r, c)];
      const gx = ox + GAP + c * (CELL + GAP);
      const gy = oy + GAP + r * (CELL + GAP);

      if (gem === null) {
        drawRoundedRect(ctx, gx, gy, CELL, CELL, 8, '#0f3460');
        continue;
      }

      const isFlashing = flashSet.has(r * COLS + c);
      const bgColor = isFlashing ? '#ffffff' : (GEM_COLORS[gem] || '#888');
      const border = isFlashing ? '#ffeb3b' : (GEM_BORDERS[gem] || '#555');

      drawRoundedRect(ctx, gx, gy, CELL, CELL, 8, bgColor, {
        strokeColor: border, strokeWidth: 2,
      });

      // Gem label (first letter)
      ctx.font = 'bold 20px monospace';
      ctx.fillStyle = isFlashing ? '#000' : '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(gem[0].toUpperCase(), gx + CELL / 2, gy + CELL / 2);

      // Selected gem golden border
      if (sel.active && sel.r === r && sel.c === c) {
        drawRoundedRect(ctx, gx - 2, gy - 2, CELL + 4, CELL + 4, 10, 'transparent', {
          strokeColor: '#FFD700', strokeWidth: 3,
        });
      }

      // Cursor highlight
      const gm = world.getResource('gameMode');
      if (gm && gm.mode === 'playerVsAi' && cursor.r === r && cursor.c === c && !state.gameOver) {
        drawRoundedRect(ctx, gx - 1, gy - 1, CELL + 2, CELL + 2, 9, 'transparent', {
          strokeColor: '#ffffff', strokeWidth: 2,
        });
      }
    }
  }

  // HUD
  const hudX = ox + BOARD_W + 12;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  ctx.font = 'bold 16px monospace';
  ctx.fillStyle = '#FFD700';
  ctx.fillText(`Score`, hudX, oy + 10);
  ctx.font = 'bold 22px monospace';
  ctx.fillText(`${state.score}`, hudX, oy + 30);

  ctx.font = '13px monospace';
  ctx.fillStyle = '#aaa';
  ctx.fillText(`Moves: ${state.moveCount}`, hudX, oy + 65);

  if (state.combo > 0) {
    ctx.font = 'bold 14px monospace';
    ctx.fillStyle = '#FF6F00';
    ctx.fillText(`Combo x${state.combo + 1}`, hudX, oy + 90);
  }

  // Phase / message
  ctx.font = '12px monospace';
  ctx.fillStyle = '#7ec8e3';
  const msgLines = wrapText(state.message, 16);
  msgLines.forEach((line, i) => {
    ctx.fillText(line, hudX, oy + 120 + i * 16);
  });

  // Gem legend
  ctx.font = '11px monospace';
  let legendY = oy + 180;
  for (const gem of GEM_TYPES) {
    drawRoundedRect(ctx, hudX, legendY, 14, 14, 3, GEM_COLORS[gem]);
    ctx.fillStyle = '#ccc';
    ctx.fillText(gem.charAt(0).toUpperCase() + gem.slice(1), hudX + 20, legendY + 2);
    legendY += 20;
  }

  // Game over overlay
  if (state.gameOver) {
    drawGameOver(ctx, ox, oy, BOARD_W, BOARD_H, {
      title: 'NO MORE MOVES',
      titleColor: '#FF6F00',
      subtitle: `Score: ${state.score} | Press R`,
    });
  }

  drawTouchOverlay(ctx, ctx.canvas.width, ctx.canvas.height);
});

// ── Text Wrapping Utility ───────────────────────────────────────────

function wrapText(text, maxChars) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line.length + word.length + 1 > maxChars && line.length > 0) {
      lines.push(line);
      line = word;
    } else {
      line = line.length > 0 ? line + ' ' + word : word;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

export default game;
