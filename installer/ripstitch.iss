; RipStitch Engine for Windows: installs per-user (no admin), starts at sign-in, runs hidden.
; Build:  powershell installer\build-windows.ps1   then   ISCC installer\ripstitch.iss

#define AppVersion GetEnv("RS_VERSION")
#if AppVersion == ""
  #define AppVersion "1.3.1"
#endif
#define AppUrl "https://mattymattmattmatt.github.io/RipStitch/"
#define Py "{app}\python\pythonw.exe"
#define PyConsole "{app}\python\python.exe"
#define Engine "{app}\engine\ripstitch_engine.py"

[Setup]
AppId={{7E4F2C1A-5B8D-4C3E-9A6F-2D1B8E7C4A90}
AppName=RipStitch Engine
AppVersion={#AppVersion}
AppVerName=RipStitch Engine {#AppVersion}
AppPublisher=Matty P from I.T.
AppPublisherURL={#AppUrl}
AppSupportURL=https://github.com/mattymattmattmatt/RipStitch
DefaultDirName={localappdata}\Programs\RipStitch
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=RipStitch-Setup
SetupIconFile=ripstitch.ico
UninstallDisplayIcon={app}\ripstitch.ico
UninstallDisplayName=RipStitch Engine
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=no
SetupLogging=yes

[Messages]
WelcomeLabel1=Install RipStitch
WelcomeLabel2=This adds the RipStitch Engine, the small helper that lets the RipStitch website download videos with yt-dlp.%n%nIt runs quietly in the background, starts with Windows and keeps itself up to date. Everything it needs is included, and no admin rights are required.
FinishedHeadingLabel=RipStitch is ready
FinishedLabel=The engine now starts by itself whenever you sign in. Just open the RipStitch website and paste a link.

[Files]
Source: "..\build\RipStitch\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[INI]
Filename: "{userprograms}\RipStitch.url"; Section: "InternetShortcut"; Key: "URL"; String: "{#AppUrl}"
Filename: "{userprograms}\RipStitch.url"; Section: "InternetShortcut"; Key: "IconFile"; String: "{app}\ripstitch.ico"
Filename: "{userprograms}\RipStitch.url"; Section: "InternetShortcut"; Key: "IconIndex"; String: "0"

[Icons]
Name: "{userstartup}\RipStitch Engine"; Filename: "{#Py}"; Parameters: """{#Engine}"" --background"; WorkingDir: "{app}"; IconFilename: "{app}\ripstitch.ico"; Comment: "Lets the RipStitch website download videos"
Name: "{userprograms}\RipStitch Engine\Start the engine"; Filename: "{#Py}"; Parameters: """{#Engine}"" --background --open"; WorkingDir: "{app}"; IconFilename: "{app}\ripstitch.ico"
Name: "{userprograms}\RipStitch Engine\Stop the engine"; Filename: "{#Py}"; Parameters: """{#Engine}"" --stop"; WorkingDir: "{app}"; IconFilename: "{app}\ripstitch.ico"
Name: "{userprograms}\RipStitch Engine\Engine log"; Filename: "{userappdata}\RipStitch\engine.log"
Name: "{userprograms}\RipStitch Engine\Uninstall RipStitch Engine"; Filename: "{uninstallexe}"

[Run]
Filename: "{#Py}"; Parameters: """{#Engine}"" --background --open"; WorkingDir: "{app}"; Description: "Start RipStitch and open the website"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{#PyConsole}"; Parameters: """{#Engine}"" --stop"; Flags: runhidden waituntilterminated; RunOnceId: "StopEngine"

[UninstallDelete]
; pip updates, byte-code caches and engine self-updates add files the installer didn't place.
Type: filesandordirs; Name: "{app}"
Type: files; Name: "{userprograms}\RipStitch.url"

[Code]
procedure StopRunningEngine();
var
  Code: Integer;
begin
  if FileExists(ExpandConstant('{#PyConsole}')) then
    Exec(ExpandConstant('{#PyConsole}'), '"' + ExpandConstant('{#Engine}') + '" --stop', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  { Upgrading in place: stop the old engine so its files aren't locked. }
  StopRunningEngine();
  Result := '';
end;
