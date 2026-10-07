import fs from 'fs';
import path from 'path';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import chokidar from 'chokidar';

const USERPROFILE = process.env.USERPROFILE || process.env.HOME;
const ED_SAVED_GAMES = path.join(
  USERPROFILE,
  'Saved Games',
  'Frontier Developments',
  'Elite Dangerous'
);

const SCOOPABLE_CLASSES = new Set(['K', 'O', 'B', 'A', 'F', 'G', 'M']);

let state = {
  currentFuel: 0,
  fuelCapacity: 32,
  hasFuelScoop: false,
  route: [],
  currentSystemIndex: 0,
  recommendedStop: null,
  willRunOut: false,
  outOfFuelAtSystem: null
};

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(process.cwd(), 'public', 'index.html'), (err, data) => {
      if (err) {
        res.writeHead(500);
        return res.end('Error loading dashboard UI');
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  }
});

const wss = new WebSocketServer({ server });

function broadcastState() {
  const payload = JSON.stringify(state);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

function isScoopable(starClass) {
  if (!starClass) return false;
  const cleanClass = starClass.trim().toUpperCase()[0];
  return SCOOPABLE_CLASSES.has(cleanClass);
}

function evaluateFuelStrategy() {
  if (!state.route.length) return;

  let estimatedFuel = state.currentFuel;
  let recommendedStop = null;
  let sysOutOfFuelIndex = -1;

  for (let i = state.currentSystemIndex; i < state.route.length - 1; i++) {
    const nextSystem = state.route[i + 1];
    const estimatedJumpCost = 4.0;

    if (estimatedFuel < estimatedJumpCost) {
      sysOutOfFuelIndex = i;
      break;
    }

    estimatedFuel -= estimatedJumpCost;

    if (estimatedFuel < (state.fuelCapacity * 0.35) && !recommendedStop) {
      if (state.hasFuelScoop && isScoopable(nextSystem.StarClass)) {
        recommendedStop = {
          system: nextSystem.StarSystem,
          starClass: nextSystem.StarClass,
          type: 'FUEL_SCOOP',
          reason: 'Scoopable star reached before low fuel threshold.'
        };
      } else if (!state.hasFuelScoop) {
        recommendedStop = {
          system: nextSystem.StarSystem,
          starClass: nextSystem.StarClass,
          type: 'DOCK_REFUEL',
          reason: 'No Fuel Scoop equipped. Plan a stop at a station to refuel.'
        };
      }
    }
  }

  state.willRunOut = sysOutOfFuelIndex !== -1;
  state.outOfFuelAtSystem = sysOutOfFuelIndex !== -1 ? state.route[sysOutOfFuelIndex].StarSystem : null;
  state.recommendedStop = recommendedStop;
}

function readStatus() {
  const statusPath = path.join(ED_SAVED_GAMES, 'Status.json');
  if (!fs.existsSync(statusPath)) return;

  try {
    const data = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    if (data.Fuel) {
      state.currentFuel = data.Fuel.FuelMain;
      evaluateFuelStrategy();
      broadcastState();
    }
  } catch (e) {}
}

function readNavRoute() {
  const routePath = path.join(ED_SAVED_GAMES, 'NavRoute.json');
  if (!fs.existsSync(routePath)) return;

  try {
    const data = JSON.parse(fs.readFileSync(routePath, 'utf8'));
    if (data.Route) {
      state.route = data.Route;
      state.currentSystemIndex = 0;
      evaluateFuelStrategy();
      broadcastState();
    }
  } catch (e) {}
}

function processJournalLine(line) {
  if (!line.trim()) return;
  try {
    const event = JSON.parse(line);

    if (event.event === 'Loadout') {
      if (event.FuelCapacity?.Main) {
        state.fuelCapacity = event.FuelCapacity.Main;
      }
      state.hasFuelScoop = event.Modules.some(mod =>
        mod.Item && mod.Item.toLowerCase().includes('int_fuelscoop')
      );
    } else if (event.event === 'FSDJump') {
      if (state.route.length) {
        const index = state.route.findIndex(r => r.StarSystem === event.StarSystem);
        if (index !== -1) {
          state.currentSystemIndex = index;
        }
      }
    }
    evaluateFuelStrategy();
    broadcastState();
  } catch (e) {}
}

function readLatestJournal() {
  if (!fs.existsSync(ED_SAVED_GAMES)) return;
  const files = fs.readdirSync(ED_SAVED_GAMES)
    .filter(f => f.startsWith('Journal.') && f.endsWith('.log'))
    .sort()
    .reverse();

  if (files.length === 0) return;

  const latestJournal = path.join(ED_SAVED_GAMES, files[0]);
  const lines = fs.readFileSync(latestJournal, 'utf8').split('\n');
  lines.forEach(processJournalLine);
}

console.log(`Watching Elite Dangerous logs at: ${ED_SAVED_GAMES}`);

readLatestJournal();
readNavRoute();
readStatus();

if (fs.existsSync(ED_SAVED_GAMES)) {
  chokidar.watch(path.join(ED_SAVED_GAMES, 'Status.json')).on('change', readStatus);
  chokidar.watch(path.join(ED_SAVED_GAMES, 'NavRoute.json')).on('change', readNavRoute);

  const watcher = chokidar.watch(path.join(ED_SAVED_GAMES, 'Journal.*.log'));
  watcher.on('change', (filePath) => {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    lines.slice(-10).forEach(processJournalLine);
  });
}

server.listen(3000, () => {
  console.log('Companion App running on http://localhost:3000');
  console.log('Open this URL on your second monitor browser window!');
});