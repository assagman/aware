import React from "react";
import { createRoot } from "react-dom/client";
import { AppRouter } from "./app/router";
import "@xyflow/react/dist/style.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<AppRouter />
	</React.StrictMode>,
);
