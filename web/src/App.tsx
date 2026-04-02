import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Toaster } from "sonner";
import ESignPage from "./pages/ESignPage";
import PublicSignPage from "./pages/PublicSignPage";

export default function App() {
  return (
    <BrowserRouter>
      <Toaster position="top-right" richColors />
      <Routes>
        <Route path="/" element={<ESignPage />} />
        <Route path="/sign/:token" element={<PublicSignPage />} />
      </Routes>
    </BrowserRouter>
  );
}
