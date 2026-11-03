import { useEffect, useState } from "react";
import { Link } from "./components/Link.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { LedgerPage } from "./pages/LedgerPage.tsx";

export function App() {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => {
      setPath(window.location.pathname);
      window.scrollTo(0, 0);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const ledger = /^\/l\/([\w-]+)\/?$/.exec(path);
  const page = ledger ? <LedgerPage id={ledger[1]!} claimId={new URLSearchParams(window.location.search).get("claim")} /> : <HomePage />;

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="wordmark">
          <span className="mark" aria-hidden="true">R</span>
          Rightful
        </Link>
        <span className="tagline">Agents can file. Only verified humans get paid.</span>
      </header>
      <main>{page}</main>
      <footer className="footer">
        <span>PayPal sandbox only. No real money moves.</span>
        <span>
          Randomness by <a href="https://drand.love" target="_blank" rel="noreferrer">drand</a> quicknet
        </span>
      </footer>
    </div>
  );
}
