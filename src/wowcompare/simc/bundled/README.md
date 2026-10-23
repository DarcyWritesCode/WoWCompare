Snapshots of SimC's default APLs (`ActionPriorityLists/default/` on the default branch, which tracks the current expansion),
used only when the live copy can't be fetched. Refresh with:

    for f in $(gh api repos/simulationcraft/simc/contents/ActionPriorityLists/default --jq '.[].name'); do
      curl -sf -o "$f" "https://raw.githubusercontent.com/simulationcraft/simc/HEAD/ActionPriorityLists/default/$f"
    done

snapshot 2026-10-22
