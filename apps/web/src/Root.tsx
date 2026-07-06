import { BrowserRouter, Routes, Route } from "react-router-dom";
import { App } from "./App";
import { HomePage } from "./pages/HomePage";
import { DuePage } from "./pages/DuePage";
import { ReviewPage } from "./pages/ReviewPage";
import { AddPage } from "./pages/AddPage";
import { DataPage } from "./pages/DataPage";
import { SettingsPage } from "./pages/SettingsPage";
import { RoadmapPage } from "./pages/RoadmapPage";
import { ReadPage } from "./pages/ReadPage";

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
          <Route path="data" element={<DataPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="roadmap" element={<RoadmapPage />} />
          <Route path="read" element={<ReadPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
