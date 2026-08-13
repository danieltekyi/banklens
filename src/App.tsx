import { Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import Home from "./pages/Home";
import Compare from "./pages/Compare";
import Products from "./pages/Products";
import Decide from "./pages/Decide";
import Rankings from "./pages/Rankings";
import BankDetail from "./pages/BankDetail";
import Methodology from "./pages/Methodology";
import NotFound from "./pages/NotFound";
import Admin from "./pages/Admin";

export default function App() {
  return <Routes><Route element={<Layout />}><Route index element={<Home />} /><Route path="rankings" element={<Rankings />} /><Route path="compare" element={<Compare />} /><Route path="decide" element={<Decide />} /><Route path="products" element={<Products />} /><Route path="banks/:slug" element={<BankDetail />} /><Route path="methodology" element={<Methodology />} /><Route path="admin" element={<Admin />} /><Route path="*" element={<NotFound />} /></Route></Routes>;
}
