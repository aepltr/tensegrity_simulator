# Tensegrity Simulator

An interactive 3D/VR simulator for tensegrity structures, built with **Babylon.js**, **TypeScript**, and **Vite**. It runs in the browser and supports WebXR for VR headsets.

---

## Requirements

| Tool | Version | Check with |
|------|---------|-----------|
| [Node.js](https://nodejs.org/) | 20 LTS or newer | `node -v` |
| npm | comes with Node.js | `npm -v` |
| [Git](https://git-scm.com/) | any recent version | `git --version` |

A modern browser is also needed (Chrome, Edge, or the Meta Quest Browser for VR).

---

## Installation

### 1. Clone the repository

> This repository is private. You need to be added as a collaborator to clone it.

```bash
git clone https://github.com/aepltr/tensegrity_simulator.git
cd tensegrity_simulator
```

### 2. Install dependencies

```bash
npm install
```

This reads `package.json` and downloads everything the project needs (Vite, TypeScript, Babylon.js) into a `node_modules/` folder. It only needs to be run once, and again whenever `package.json` changes.

### 3. Start the development server

```bash
npm run dev
```

Vite prints a local address, usually:

```
  ➜  Local:   http://localhost:5173/
```

Open that address in your browser. The page reloads automatically whenever you save a file.

To stop the server, press **Ctrl + C** in the terminal.

---

## Other commands

| Command | What it does |
|---------|-------------|
| `npm run dev` | Starts the development server with live reload |
| `npm run build` | Type-checks and builds an optimized version into `dist/` |
| `npm run preview` | Serves the built `dist/` folder locally to test the production build |

---

## Running on a VR headset

WebXR only works on a **secure context**: either `localhost` or an `https://` address.

- **Desktop testing:** `http://localhost:5173` works as-is.
- **Headset on the same Wi-Fi network:** start the server so it is visible on your network:

  ```bash
  npm run dev -- --host
  ```

  Vite will print a `Network:` address (e.g. `http://192.168.x.x:5173`). Because this address is not `localhost`, the headset browser will block VR mode unless it is served over HTTPS. One way to enable HTTPS in development:

  ```bash
  npm install -D @vitejs/plugin-basic-ssl
  ```

  Then add the plugin to `vite.config.ts`:

  ```ts
  import { defineConfig } from "vite";
  import basicSsl from "@vitejs/plugin-basic-ssl";

  export default defineConfig({
    plugins: [basicSsl()],
  });
  ```

  Restart `npm run dev -- --host`, open the `https://` network address on the headset, and accept the browser's certificate warning.

---

## Project structure

```
tensegrity_simulator/
├── index.html              # Entry page loaded by Vite
├── package.json            # Dependencies and npm scripts
├── tsconfig.json           # TypeScript settings
├── public/                 # Static files served as-is (icons)
└── src/
    ├── main.ts             # App entry point: sets up the Babylon.js scene
    ├── strcture.ts         # Tensegrity structure geometry
    ├── materials.ts        # Materials and colors
    ├── moonEnvironment.ts  # Lunar environment
    ├── substitution.ts     # Substitution logic
    ├── substitutionPanel.ts# UI panel for substitution parameters
    ├── style.css           # Page styles
    └── assets/             # Images used by the app
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `command not found: npm` | Node.js is not installed. Install it from [nodejs.org](https://nodejs.org/), then reopen the terminal. |
| `Cannot find module ...` | Run `npm install` again. |
| Port 5173 already in use | Another dev server is running. Stop it with **Ctrl + C**, or Vite will pick the next free port automatically. |
| VR button missing on headset | The page is not on a secure context. See [Running on a VR headset](#running-on-a-vr-headset). |
| Blank page | Open the browser console (**F12** or **Cmd + Option + I**) and check for errors. |

---

## Author

Alizée Pelletier, University of Houston
