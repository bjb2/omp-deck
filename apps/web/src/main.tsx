import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { registerServiceWorker } from "./lib/pwa";
import "./styles.css";

// Registered at boot, unconditionally — this is what makes the deck
// installable and what lets push notifications reach a closed tab. The
// worker itself does no caching (see public/sw.js), so registering it early
// carries none of the "stale app after deploy" risk a caching SW would.
registerServiceWorker();

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<App />
	</React.StrictMode>,
);
