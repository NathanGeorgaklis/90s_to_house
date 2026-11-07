# Run me first: deploy to Modal and run the self-test

This first milestone is only: deploy to Modal, then run one real GPU rework on the bundled 14-second test clip and
measure it. You don't need your own songs yet. Prepare the 20–30-song set only after the self-test passes.

You need: a Mac, internet, and a free Modal account (you'll be asked to sign in during Step 1).
Budget: the self-test costs a few cents of Modal credit.

## Open Terminal in the right folder

1. Unzip `ai-house-rework.zip` (double-click it in Finder).
2. Open **Terminal** (press Cmd+Space, type `Terminal`, press Return).
3. Type `cd ` (with a space), drag the `ai-house-rework/server` folder from Finder into the Terminal window, then press Return.
4. Check you're in the right place: `ls` should list `rework.sh`, `modal_app.py` and `RUN_ME_FIRST.md`.

Paste each command below and press Return. Wait for each one to finish before running the next.

## Step 1 — set up (about 2–5 minutes)

```
bash rework.sh setup
```

- **What happens:** it makes a private Python environment in `.venv` and installs Modal there. Then a browser tab opens so you can sign in to Modal (click Approve/Authorize). Finally it creates the API key and saves it to `eval/.env`.
- **Success:** the last line is `SETUP OK`.
- **If it fails:**
  - `STOPPED: Python 3.10 or newer is needed`: install Python from https://www.python.org/downloads/macos/ (the "macOS 64-bit universal2 installer"), close Terminal, open it again, and repeat from "Open Terminal".
  - The browser sign-in didn't finish: run `bash rework.sh setup` again.
  - `xcrun: error` or "install command line developer tools": click Install in the pop-up, wait, then rerun.
  - `STOPPED: Modal already has a secret named rework-api …`: follow the command it prints.
  - Anything else: send me the full Terminal output.

## Step 2 — deploy (first time about 10–20 minutes)

```
bash rework.sh deploy
```

- **What happens:** Modal builds the images (PyTorch, the separation model, Node and the render engine) and starts the app. The first build is slow; later deploys take about a minute.
- **Success:** the output ends with `DEPLOY OK` and a line `API: https://…modal.run`.
- **If it fails:** the error printed just above `STOPPED` names the step (usually an image build line). Send me the last ~60 lines of output. Running it again is safe.

## Step 3 — self-test (first time about 3–8 minutes)

```
bash rework.sh selftest
```

- **What happens:**
  1. It approves the test clip, then confirms that the API key is enforced and that an unapproved file is refused.
  2. It runs a full rework on a GPU (the first run also downloads the separation model, about 600 MB, into Modal storage).
  3. It downloads the result.
  4. It runs **New beat** and confirms that separation and analysis were reused.
  5. It runs a second full rework, which gives the warm, steady-state cost.
- **Success:** a box with `SELF-TEST PASSED`, then the timing and cost summary.
- **Results are saved in:** `eval/selftest/<date-time>/` (`summary.txt`, `summary.json` and the reworked WAVs).
- **If it fails:** the summary says `SELF-TEST FAILED` and lists the failed checks. Nothing is hidden. Send me the whole output plus `summary.json`.
- **Expected even on a pass:** the master measures quieter than target (about −15 to −18 LUFS). This is a known open issue and isn't judged in the self-test.

## After the self-test passes (not before)

Then, and only then, follow "Then the evaluation" in `README.md`:
- put your songs in `eval/songs/`
- fill `eval/songs.csv`
- run `bash rework.sh approve`, `bash rework.sh eval`, listen, then `bash rework.sh report`
