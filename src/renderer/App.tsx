import { useState } from "react";
import { TestCasesPage } from "./pages/TestCasesPage";
import { EnvironmentsPage } from "./pages/EnvironmentsPage";
import { TrainingPage, type TrainingIntent } from "./pages/TrainingPage";
import { TestingPage } from "./pages/TestingPage";
import { HistoryPage } from "./pages/HistoryPage";
import { SettingsPage } from "./pages/SettingsPage";

type PageId = "cases" | "envs" | "training" | "testing" | "history" | "settings";

const NAV: { id: PageId; label: string }[] = [
  { id: "cases", label: "Test Cases" },
  { id: "envs", label: "Environment" },
  { id: "training", label: "Training" },
  { id: "testing", label: "Testing" },
  { id: "history", label: "History" },
];

export function App() {
  const [page, setPage] = useState<PageId>("cases");
  const [trainingIntent, setTrainingIntent] = useState<TrainingIntent | null>(null);
  const [testingIntent, setTestingIntent] = useState<{ test_id: string } | null>(null);

  const openTraining = (intent: TrainingIntent) => {
    setTrainingIntent({ ...intent, nonce: Date.now() });
    setPage("training");
  };
  const openTesting = (testId: string) => {
    setTestingIntent({ test_id: testId });
    setPage("testing");
  };

  return (
    <div className="shell">
      <nav className="nav" aria-label="Điều hướng">
        <div className="brand">
          E2E AI TRAINER
          <small>Training & chạy web E2E test</small>
        </div>
        {NAV.map((n) => (
          <button key={n.id} className={page === n.id ? "active" : ""} onClick={() => setPage(n.id)}>
            {n.label}
          </button>
        ))}
        <div className="grow" />
        <button className={page === "settings" ? "active" : ""} onClick={() => setPage("settings")}>
          Cài đặt
        </button>
        <div className="foot">Playwright · Codex · Cursor</div>
      </nav>
      <main className="main">
        {page === "cases" && <TestCasesPage onTrain={(test_id) => openTraining({ test_id })} onTest={openTesting} />}
        {page === "envs" && <EnvironmentsPage />}
        {page === "training" && <TrainingPage intent={trainingIntent} onTest={openTesting} />}
        {page === "testing" && <TestingPage intent={testingIntent} onSendToTraining={openTraining} />}
        {page === "history" && <HistoryPage onOpenTraining={(test_id) => openTraining({ test_id })} />}
        {page === "settings" && <SettingsPage />}
      </main>
    </div>
  );
}
