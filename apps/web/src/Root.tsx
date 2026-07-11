import { BrowserRouter, Routes, Route } from "react-router-dom";
import { IntlayerProvider } from "react-intlayer";
import { App } from "./App";
import "./index.css";
import { HomePage } from "./pages/HomePage";
import { DuePage } from "./pages/DuePage";
import { ReviewPage } from "./pages/ReviewPage";
import { AddPage } from "./pages/AddPage";
import { DataPage } from "./pages/DataPage";
import { SettingsPage } from "./pages/SettingsPage";
import { RoadmapPage } from "./pages/RoadmapPage";
import { ReadPage } from "./pages/ReadPage";
import { AiPage } from "./pages/AiPage";
import { ContactPage } from "./pages/ContactPage";
import { ProfilePage } from "./pages/ProfilePage";
import { SignInPage } from "./pages/SignInPage";
import { PolyglotPage } from "./pages/PolyglotPage";
import { SelfIntroPage } from "./pages/SelfIntroPage";
import { BlogListPage } from "./pages/BlogListPage";
import { BlogPostPage } from "./pages/BlogPostPage";

// The routed app, exported so it can be mounted both standalone (apps/web
// main.tsx) and by the apps/api Worker's client bundle (single-origin serving).
export function Root() {
  return (
    <IntlayerProvider>
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
            <Route path="ai" element={<AiPage />} />
            <Route path="profile" element={<ProfilePage />} />
            <Route path="contact" element={<ContactPage />} />
            <Route path="signin" element={<SignInPage />} />
            <Route path="polyglot" element={<PolyglotPage />} />
            <Route path="self-intro" element={<SelfIntroPage />} />
            <Route path="blog" element={<BlogListPage />} />
            <Route path="blog/:slug" element={<BlogPostPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </IntlayerProvider>
  );
}
