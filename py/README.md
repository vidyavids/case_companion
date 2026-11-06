# Python Clocked test

Verifies the Clocked calls against the synthetic demo case before the web app
uses them. Requires a Clocked API key (never committed).

Setup (from repo root):

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r py\requirements.txt
Copy-Item py\.env.example py\.env   # then edit py\.env and add your key
```

Run:

```powershell
.\.venv\Scripts\python.exe py\test_clocked.py
```

The script calls Extract (15 fields), Decide (4 questions), then Fill
(one-page brief record), prints the full JSON of each, and checks every
Extract value against the known synthetic facts. Exit code is non-zero if
any check fails.
