import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { App } from "./App";
import { HomePage } from "./pages/HomePage";
import { DuePage } from "./pages/DuePage";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<App />}>
          <Route index element={<HomePage />} />
          <Route path="due" element={<DuePage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
