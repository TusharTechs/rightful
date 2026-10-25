import { useEffect, useState } from "react";
import { Link } from "./components/Link.tsx";
import { BallotPage } from "./pages/BallotPage.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { ReceiptPage } from "./pages/ReceiptPage.tsx";

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

  const ballot = /^\/b\/([\w-]+)\/?$/.exec(path);
  const entry = /^\/e\/([\w-]+)\/?$/.exec(path);
  const page = ballot ? <BallotPage id={ballot[1]!} /> : entry ? <ReceiptPage id={entry[1]!} /> : <HomePage />;

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="wordmark">
          <span className="mark" aria-hidden="true">F</span>
          Firsthand
        </Link>
        <span className="tagline">Agents welcome. Bots aren't.</span>
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
