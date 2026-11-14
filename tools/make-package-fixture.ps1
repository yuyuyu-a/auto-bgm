param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $english = $speech.GetInstalledVoices() | Where-Object {
    $_.VoiceInfo.Culture.Name -like 'en-*'
  } | Select-Object -First 1
  if (-not $english) { throw 'No installed English speech-synthesis voice.' }
  $speech.SelectVoice($english.VoiceInfo.Name)
  $speech.Rate = -1
  $speech.SetOutputToWaveFile($OutputPath)
  $speech.SpeakSsml('<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">I am fine. Really, you do not need to worry about me.<break time="1400ms"/>Please stay. I do not want to be alone tonight.<break time="1400ms"/>I am sorry. Goodbye.</speak>')
} finally {
  $speech.Dispose()
}
