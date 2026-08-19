import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Nav } from "./components/Nav";
import { Dashboard } from "./pages/Dashboard";
import { Library } from "./pages/Library";
import { Queue } from "./pages/Queue";
import { Settings } from "./pages/Settings";

function App() {
  return (
    <BrowserRouter>
      <Nav />
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/library" element={<Library />} />
        <Route path="/queue" element={<Queue />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </BrowserRouter>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
