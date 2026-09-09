' Atlantis one-click launcher.
' This is what the Desktop shortcut (created by setup.bat) points to.
' Plain text, nothing hidden: it starts Ollama's background server if it
' isn't already running, then launches Atlantis itself, both without a
' console window flashing up -- the Atlantis app window is what you see.

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)

' Is Ollama's local API already responding?
ollamaRunning = False
On Error Resume Next
Set http = CreateObject("MSXML2.XMLHTTP")
http.Open "GET", "http://127.0.0.1:11434/api/version", False
http.Send()
If Err.Number = 0 And http.Status = 200 Then
    ollamaRunning = True
End If
Err.Clear
On Error Goto 0

If Not ollamaRunning Then
    ollamaPath = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\Ollama\ollama.exe"
    If fso.FileExists(ollamaPath) Then
        sh.Run Chr(34) & ollamaPath & Chr(34) & " serve", 0, False
    Else
        sh.Run "ollama serve", 0, False
    End If
    WScript.Sleep 2500
End If

' Launch Atlantis using the venv's windowless Python interpreter.
pyw = here & "\.venv\Scripts\pythonw.exe"
script = here & "\run_atlantis.py"

If Not fso.FileExists(pyw) Then
    MsgBox "Atlantis isn't set up yet." & vbCrLf & vbCrLf & _
           "Run setup.bat in this folder once, then use this shortcut from then on.", _
           vbExclamation, "Atlantis"
    WScript.Quit 1
End If

sh.CurrentDirectory = here
sh.Run Chr(34) & pyw & Chr(34) & " " & Chr(34) & script & Chr(34), 0, False
