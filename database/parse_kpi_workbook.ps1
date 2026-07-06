[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$WorkbookPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-EntryText {
  param(
    [System.IO.Compression.ZipArchive]$Zip,
    [string]$EntryPath
  )

  $entry = $Zip.GetEntry($EntryPath)
  if (-not $entry) {
    return $null
  }

  $stream = $entry.Open()
  try {
    $reader = New-Object System.IO.StreamReader($stream)
    try {
      return $reader.ReadToEnd()
    }
    finally {
      $reader.Dispose()
    }
  }
  finally {
    $stream.Dispose()
  }
}

function Get-CellColumn {
  param([string]$CellRef)
  return ($CellRef -replace '\d', '')
}

function Get-CellValue {
  param(
    $Cell,
    [System.Collections.Generic.List[string]]$SharedStrings
  )

  $typeProperty = $Cell.PSObject.Properties['t']
  $type = if ($typeProperty) { [string]$typeProperty.Value } else { '' }
  if ($type -eq 'inlineStr') {
    return (($Cell.is.t | ForEach-Object { $_.'#text' }) -join '')
  }

  $valueProperty = $Cell.PSObject.Properties['v']
  $valueNode = if ($valueProperty) { $valueProperty.Value } else { $null }
  if ($null -eq $valueNode) {
    $inlineProperty = $Cell.PSObject.Properties['is']
    $inlineValue = if ($inlineProperty) { $inlineProperty.Value } else { $null }
    if ($inlineValue -and $inlineValue.t) {
      return (($inlineValue.t | ForEach-Object { $_.'#text' }) -join '')
    }
    return ''
  }

  $raw = [string]$valueNode
  if ($type -eq 's') {
    $index = 0
    if ([int]::TryParse($raw, [ref]$index) -and $index -ge 0 -and $index -lt $SharedStrings.Count) {
      return $SharedStrings[$index]
    }
  }

  return $raw
}

function Get-WorkbookSheets {
  param([System.IO.Compression.ZipArchive]$Zip)

  [xml]$workbookXml = Get-EntryText -Zip $Zip -EntryPath 'xl/workbook.xml'
  [xml]$relsXml = Get-EntryText -Zip $Zip -EntryPath 'xl/_rels/workbook.xml.rels'

  $workbookNs = New-Object System.Xml.XmlNamespaceManager($workbookXml.NameTable)
  $workbookNs.AddNamespace('x', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')
  $workbookNs.AddNamespace('r', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')

  $relsNs = New-Object System.Xml.XmlNamespaceManager($relsXml.NameTable)
  $relsNs.AddNamespace('r', 'http://schemas.openxmlformats.org/package/2006/relationships')

  $relationshipMap = @{}
  $relsXml.SelectNodes('//r:Relationship', $relsNs) | ForEach-Object {
    $relationshipMap[$_.Id] = $_.Target
  }

  $sheets = New-Object System.Collections.Generic.List[object]
  foreach ($sheet in $workbookXml.SelectNodes('//x:sheets/x:sheet', $workbookNs)) {
    $relId = $sheet.GetAttribute('id', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
    $target = $relationshipMap[$relId]
    if (-not $target) {
      continue
    }

    $sheetPath = if ($target.StartsWith('/')) {
      $target.TrimStart('/')
    }
    else {
      'xl/' + $target.TrimStart('/')
    }

    $sheets.Add([PSCustomObject]@{
      Name = [string]$sheet.name
      Path = $sheetPath
    }) | Out-Null
  }

  return $sheets
}

function Get-SharedStrings {
  param([System.IO.Compression.ZipArchive]$Zip)

  $sharedStrings = New-Object System.Collections.Generic.List[string]
  $sharedText = Get-EntryText -Zip $Zip -EntryPath 'xl/sharedStrings.xml'
  if (-not $sharedText) {
    return $sharedStrings
  }

  [xml]$sharedXml = $sharedText
  $ns = New-Object System.Xml.XmlNamespaceManager($sharedXml.NameTable)
  $ns.AddNamespace('x', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')
  $sharedXml.SelectNodes('//x:si', $ns) | ForEach-Object {
    $parts = $_.SelectNodes('.//x:t', $ns) | ForEach-Object { $_.'#text' }
    $sharedStrings.Add(($parts -join '')) | Out-Null
  }

  return $sharedStrings
}

function Get-SheetRows {
  param(
    [System.IO.Compression.ZipArchive]$Zip,
    [string]$SheetPath,
    [System.Collections.Generic.List[string]]$SharedStrings
  )

  [xml]$sheetXml = Get-EntryText -Zip $Zip -EntryPath $SheetPath
  $sheetNs = New-Object System.Xml.XmlNamespaceManager($sheetXml.NameTable)
  $sheetNs.AddNamespace('x', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')

  $rows = New-Object System.Collections.Generic.List[object]
  foreach ($row in $sheetXml.SelectNodes('//x:sheetData/x:row', $sheetNs)) {
    $cellMap = [ordered]@{}
    foreach ($cell in $row.SelectNodes('./x:c', $sheetNs)) {
      $column = Get-CellColumn -CellRef $cell.r
      $cellMap[$column] = (Get-CellValue -Cell $cell -SharedStrings $SharedStrings)
    }

    $rows.Add([PSCustomObject]@{
      RowNumber = [int]$row.r
      Cells = [PSCustomObject]$cellMap
    }) | Out-Null
  }

  return $rows
}

function Get-CellText {
  param(
    $Cells,
    [string]$Column
  )

  $property = $Cells.PSObject.Properties[$Column]
  if (-not $property) {
    return ''
  }

  return [string]$property.Value
}

if (-not (Test-Path -LiteralPath $WorkbookPath)) {
  throw "Workbook not found: $WorkbookPath"
}

$zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $WorkbookPath))
try {
  $sharedStrings = Get-SharedStrings -Zip $zip
  $sheets = Get-WorkbookSheets -Zip $zip

  $employeeSheet = $sheets | Where-Object { $_.Name -notmatch 'KPI' } | Select-Object -First 1
  if (-not $employeeSheet) {
    $employeeSheet = $sheets | Select-Object -Last 1
  }

  $kpiSheets = $sheets | Where-Object { $_.Name -match 'KPI' }
  if (-not $kpiSheets) {
    $kpiSheets = $sheets | Where-Object { $_.Path -ne $employeeSheet.Path }
  }

  $kpiRows = New-Object System.Collections.Generic.List[object]
  foreach ($sheet in $kpiSheets) {
    $rows = Get-SheetRows -Zip $zip -SheetPath $sheet.Path -SharedStrings $sharedStrings
    $currentPosition = ''
    $metricIndexForPosition = 0

    foreach ($row in $rows) {
      if ($row.RowNumber -lt 5) {
        continue
      }

      $cells = $row.Cells
      $metricName = Get-CellText -Cells $cells -Column 'D'
      if (-not $metricName) {
        continue
      }

      $positionTitle = Get-CellText -Cells $cells -Column 'A'
      if ($positionTitle) {
        $currentPosition = $positionTitle
        $metricIndexForPosition = 0
      }

      if (-not $currentPosition) {
        continue
      }

      $metricIndexForPosition += 1
      $blockCode = if ($metricIndexForPosition -le 4) { 'block_a' } else { 'block_b' }
      $sortOrder = if ($metricIndexForPosition -le 4) { $metricIndexForPosition } else { $metricIndexForPosition - 4 }

      $weightText = Get-CellText -Cells $cells -Column 'E'
      $weight = if ($weightText) { [double]$weightText.Replace(',', '.') } else { 0 }

      $kpiRows.Add([PSCustomObject]@{
        sheetName = $sheet.Name
        positionTitle = $currentPosition
        blockCode = $blockCode
        metricName = $metricName
        weight = $weight
        normText = (Get-CellText -Cells $cells -Column 'F')
        sortOrder = $sortOrder
      }) | Out-Null
    }
  }

  $employees = New-Object System.Collections.Generic.List[object]
  if ($employeeSheet) {
    foreach ($row in (Get-SheetRows -Zip $zip -SheetPath $employeeSheet.Path -SharedStrings $sharedStrings)) {
      if ($row.RowNumber -lt 4) {
        continue
      }

      $cells = $row.Cells
      $fullName = Get-CellText -Cells $cells -Column 'B'
      $positionTitle = Get-CellText -Cells $cells -Column 'C'
      if (-not $fullName -or -not $positionTitle) {
        continue
      }

      $employees.Add([PSCustomObject]@{
        fullName = $fullName
        positionTitle = $positionTitle
        unitName = (Get-CellText -Cells $cells -Column 'D')
      }) | Out-Null
    }
  }

  [PSCustomObject]@{
    employees = $employees
    kpiRows = $kpiRows
  } | ConvertTo-Json -Depth 6
}
finally {
  $zip.Dispose()
}
