import type { ReactElement } from "react";

type ConfirmButtonProps = {
  disabled: boolean;
  canConfirm: boolean;
  hint: string;
  onClick: () => Promise<void>;
};

export function ConfirmButton({ disabled, canConfirm, hint, onClick }: ConfirmButtonProps): ReactElement {
  return (
    <div className="action-card">
      <h3>Confirm Delivery</h3>
      <p>Only the configured verifier can mark the escrow as confirmed.</p>
      <p className="action-hint">{hint}</p>
      <button className="primary-button" disabled={disabled || !canConfirm} onClick={() => void onClick()} type="button">
        {disabled ? "Confirming..." : "Confirm"}
      </button>
    </div>
  );
}
