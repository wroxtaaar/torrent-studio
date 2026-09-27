import React from "react";
import { createRoot } from "react-dom/client";
import SeedrReactTest from "./SeedrReactStreamTest";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SeedrReactTest />
  </React.StrictMode>
);
