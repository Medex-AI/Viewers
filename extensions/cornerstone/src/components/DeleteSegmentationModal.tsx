import React from 'react';
import { FooterAction } from '@ohif/ui-next';

type DeleteSegmentationModalProps = {
  hide: () => void;
  onConfirm: () => void;
  segmentationLabel?: string;
};

export function DeleteSegmentationModal({
  hide,
  onConfirm,
  segmentationLabel,
}: DeleteSegmentationModalProps) {
  const label = segmentationLabel?.trim() || 'this segmentation';

  return (
    <div className="text-foreground text-[13px]">
      <div>
        <p>
          Delete <span className="font-medium">{label}</span>?
        </p>
        <p className="mt-2">
          This permanently removes the segmentation and all its labels from the viewer and
          deletes any saved data from the backend.
        </p>
      </div>
      <FooterAction className="mt-4">
        <FooterAction.Right>
          <FooterAction.Secondary onClick={hide}>Cancel</FooterAction.Secondary>
          <FooterAction.Secondary
            className="border-red-700 bg-red-600 text-white hover:bg-red-700"
            data-cy="confirm-delete-segmentation"
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

export default DeleteSegmentationModal;
