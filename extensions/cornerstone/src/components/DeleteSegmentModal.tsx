import React from 'react';
import { FooterAction } from '@ohif/ui-next';

type DeleteSegmentModalProps = {
  hide: () => void;
  onConfirm: () => void;
  segmentLabel?: string;
};

export function DeleteSegmentModal({
  hide,
  onConfirm,
  segmentLabel,
}: DeleteSegmentModalProps) {
  const label = segmentLabel?.trim() || 'this label';

  return (
    <div className="text-foreground text-[13px]">
      <div>
        <p>
          Delete <span className="font-medium">{label}</span>?
        </p>
        <p className="mt-2">
          This clears its annotation data from the segmentation and saves the removal to the
          backend.
        </p>
      </div>
      <FooterAction className="mt-4">
        <FooterAction.Right>
          <FooterAction.Secondary onClick={hide}>Cancel</FooterAction.Secondary>
          <FooterAction.Secondary
            className="border-red-700 bg-red-600 text-white hover:bg-red-700"
            onClick={() => {
              onConfirm();
              hide();
            }}
          >
            Delete
          </FooterAction.Secondary>
        </FooterAction.Right>
      </FooterAction>
    </div>
  );
}

export default DeleteSegmentModal;
