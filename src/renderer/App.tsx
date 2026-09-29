import { useState } from "react";
import { TestCasesPage } from "./pages/TestCasesPage";
import { EnvironmentsPage } from "./pages/EnvironmentsPage";
import { TrainingPage, type TrainingIntent } from "./pages/TrainingPage";
import { TestingPage } from "./pages/TestingPage";
import { HistoryPage } from "./pages/HistoryPage";
import { SettingsPage } from "./pages/SettingsPage";

type PageId = "cases" | "envs" | "training" | "testing" | "history" | "settings";

/** The numbered pages follow the working order: import → environment → train → test. */
const WORKFLOW: { id: PageId; label: string }[] = [
  { id: "cases", label: "Test Cases" },
  { id: "envs", label: "Environment" },
  { id: "training", label: "Training" },
  { id: "testing", label: "Testing" },
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

  const tab = (id: PageId, label: string, step?: number) => (
    <button key={id} className={page === id ? "active" : ""} aria-current={page === id ? "page" : undefined} onClick={() => setPage(id)}>
      {step !== undefined && <span className="step">{step}</span>}
      {label}
    </button>
  );

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand" title="Training & chạy web E2E test">
          <b>E2E</b> AI TRAINER
        </div>
        <nav className="topnav" aria-label="Điều hướng">
          {WORKFLOW.map((n, i) => tab(n.id, n.label, i + 1))}
          <span className="sep" aria-hidden="true" />
          {tab("history", "History")}
          <span className="grow" />
          {tab("settings", "Cài đặt")}
        </nav>
      </header>
      <main className="main">
        <div className="page">
          {page === "cases" && <TestCasesPage onTrain={(test_id) => openTraining({ test_id })} onTest={openTesting} />}
          {page === "envs" && <EnvironmentsPage />}
          {page === "training" && <TrainingPage intent={trainingIntent} onTest={openTesting} />}
          {page === "testing" && <TestingPage intent={testingIntent} onSendToTraining={openTraining} />}
          {page === "history" && <HistoryPage onOpenTraining={(test_id) => openTraining({ test_id })} />}
          {page === "settings" && <SettingsPage />}
        </div>
      </main>
    </div>
  );
}
