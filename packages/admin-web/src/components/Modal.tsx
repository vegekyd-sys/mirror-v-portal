// Minimal modal dialog used by admin pages (create/edit forms, token reveal).
import type { ReactNode } from 'react';
import { IconX } from './icons';

interface ModalProps {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}

export default function Modal({ title, open, onClose, children, width = 520 }: ModalProps) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal-card"
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="modal-close" onClick={onClose} aria-label="关闭">
            <IconX size={14} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
