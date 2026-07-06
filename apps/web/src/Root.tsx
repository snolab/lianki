import { BrowserRouter, Routes, Route } from "react-router-dom";
import { App } from "./App";
import { HomePage } from "./pages/HomePage";
import { DuePage } from "./pages/DuePage";
import { ReviewPage } from "./pages/ReviewPage";
import { AddPage } from "./pages/AddPage";

// The routed app, exported so it can be mounted both standalone (apps/web
// main.tsx) and by the apps/api Worker's client bundle (single-origin serving).
export function Root() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<App />}>
          <Route index element={<HomePage />} />
          <Route path="add" element={<AddPage />} />
          <Route path="review" element={<ReviewPage />} />
          <Route path="due" element={<DuePage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
