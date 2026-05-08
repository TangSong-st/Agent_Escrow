import type { ReactElement } from "react";

type ExecuteButtonProps = {
  disabled: boolean;
  hint: string;
  onClick: () => Promise<void>;
};

export function ExecuteButton({ disabled, hint, onClick }: ExecuteButtonProps): ReactElement {
  return (
    <div className="action-card accent-card">
      <h3>Execute Settlement</h3>
      <p>Anyone can execute, but the contract decides the result.</p>
      <p className="action-hint">{hint}</p>
      <button className="primary-button" disabled={disabled} onClick={() => void onClick()} type="button">
        {disabled ? "Executing..." : "Execute"}
      </button>
    </div>
  );
}
