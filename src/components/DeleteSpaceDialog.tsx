/**
 * Confirmation dialog for deleting a space and everything related to it.
 * Used from the catalog card and the space page; `trigger` is the button
 * that opens it.
 */
import { useState, type ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { spaces } from "@/api/spaces";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export function DeleteSpaceDialog({
  scanId,
  scanName,
  trigger,
  onDeleted,
}: {
  scanId: string;
  scanName: string;
  trigger: ReactElement;
  onDeleted?: () => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  return (
    <AlertDialog open={open} onOpenChange={(next) => !deleting && setOpen(next)}>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this space?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes “{scanName}”: its photos and depth file, 2D plan, 3D model and
            point cloud data, detected objects, surfaces and portals, scan layers, navigation graph,
            acoustic data and analysis history. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={deleting}
            className="bg-destructive font-semibold text-destructive-foreground hover:bg-destructive/90"
            onClick={async (e) => {
              e.preventDefault();
              setDeleting(true);
              try {
                // The row goes at once; its files are removed by the worker.
                await spaces.remove(scanId);
                queryClient.removeQueries({ queryKey: ["space", scanId] });
                queryClient.removeQueries({ queryKey: ["space-export", scanId] });
                await queryClient.invalidateQueries({ queryKey: ["spaces"] });
                toast.success("Space deleted");
                setOpen(false);
                onDeleted?.();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Could not delete space");
              } finally {
                setDeleting(false);
              }
            }}
          >
            {deleting ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
