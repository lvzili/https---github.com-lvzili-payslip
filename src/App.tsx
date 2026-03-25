import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from 'xlsx';
import { listen } from "@tauri-apps/api/event";
import {
  buildDefaultBodyTemplate,
  DEFAULT_SMTP,
  DEFAULT_SUBJECT_TEMPLATE,
  exportFailedRows,
  type PayslipSettings,
  parsePayslipFile,
  type PreviewResponse,
  type SendRequest,
  type SendResponse,
  type SmtpSettings,
} from "./payslip";
import {
  isTauriRuntime,
  loadSettings,
  saveSettings,
  sendPayslips,
} from "./runtime";

const PREVIEW_STATUS_TEXT = {
  READY: "可发送",
  INVALID: "校验失败",
  SKIPPED: "已跳过",
} as const;

const SEND_STATUS_TEXT = {
  SUCCESS: "发送成功",
  FAILED: "发送失败",
} as const;

type SmtpValidationErrors = Partial<
  Record<"host" | "port" | "username" | "password" | "fromAddress", string>
>;

type SendProgressEvent = {
  processedCount: number;
  totalCount: number;
  rowNumber: number;
  recipientName: string;
  email: string;
  status: "SUCCESS" | "FAILED";
};

function validateSmtpSettings(smtp: SmtpSettings): SmtpValidationErrors {
  const errors: SmtpValidationErrors = {};

  if (!smtp.host.trim()) {
    errors.host = "请输入 SMTP 主机";
  }

  const port = smtp.port.trim();
  if (!port) {
    errors.port = "请输入端口";
  } else {
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber <= 0 || portNumber > 65535) {
      errors.port = "端口必须是 1 到 65535 的整数";
    }
  }

  if (!smtp.fromAddress.trim()) {
    errors.fromAddress = "请输入发件邮箱";
  }

  if (smtp.auth && !smtp.username.trim()) {
    errors.username = "启用 SMTP 认证时必须填写用户名";
  }

  if (smtp.auth && !smtp.password.trim()) {
    errors.password = "启用 SMTP 认证时必须填写密码或授权码";
  }

  return errors;
}

function waitForNextPaint() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const employeeFileInputRef = useRef<HTMLInputElement | null>(null);
  const [currentPage, setCurrentPage] = useState<'main' | 'employee'>('main');
  const [file, setFile] = useState<File | null>(null);
  const [employeeFile, setEmployeeFile] = useState<File | null>(null);
  const [employeeData, setEmployeeData] = useState<any[]>([]);
  const [employeeDataSaved, setEmployeeDataSaved] = useState(false);
  const [allEmployeeFields, setAllEmployeeFields] = useState<string[]>([]);
  const [isEmployeeFileLoading, setIsEmployeeFileLoading] = useState(false);
  const [defaultSubjectTemplate, setDefaultSubjectTemplate] = useState(
    DEFAULT_SUBJECT_TEMPLATE,
  );
  const [defaultBodyTemplate, setDefaultBodyTemplate] = useState(
    buildDefaultBodyTemplate(),
  );
  const [defaultSmtp, setDefaultSmtp] = useState<SmtpSettings>(DEFAULT_SMTP);
  const [subjectTemplate, setSubjectTemplate] = useState(
    DEFAULT_SUBJECT_TEMPLATE,
  );
  const [bodyTemplate, setBodyTemplate] = useState(buildDefaultBodyTemplate());
  const [smtp, setSmtp] = useState<SmtpSettings>(DEFAULT_SMTP);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [sendResult, setSendResult] = useState<SendResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [sendProgressCount, setSendProgressCount] = useState(0);
  const [sendProgressTotal, setSendProgressTotal] = useState(0);
  const [sendProgressCurrentLabel, setSendProgressCurrentLabel] = useState<
    string | null
  >(null);
  const [sendProgressSuccessCount, setSendProgressSuccessCount] = useState(0);
  const [sendProgressFailureCount, setSendProgressFailureCount] = useState(0);

  useEffect(() => {
    let active = true;
    loadSettings()
      .then((settings) => {
        if (!active) {
          return;
        }
        setDefaultSubjectTemplate(settings.defaultSubjectTemplate);
        setDefaultBodyTemplate(settings.defaultBodyTemplate);
        setDefaultSmtp(settings.smtp);
        setSubjectTemplate(settings.defaultSubjectTemplate);
        setBodyTemplate(settings.defaultBodyTemplate);
        setSmtp({
          host: settings.smtp.host,
          port: settings.smtp.port,
          username: settings.smtp.username,
          password: settings.smtp.password,
          fromAddress: settings.smtp.fromAddress,
          fromName: settings.smtp.fromName,
          auth: settings.smtp.auth,
          starttls: settings.smtp.starttls,
        });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  // 当员工信息数据变化时，重新执行预览
  useEffect(() => {
    if (employeeData.length > 0 && file) {
      void handlePreview(file);
    }
  }, [employeeData, file]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let unlisten: (() => void) | undefined;
    void listen<SendProgressEvent>("payslip-send-progress", (event) => {
      const payload = event.payload;
      setSendProgressCount(payload.processedCount);
      setSendProgressTotal(payload.totalCount);
      setSendProgressSuccessCount((current) =>
        payload.status === "SUCCESS" ? current + 1 : current,
      );
      setSendProgressFailureCount((current) =>
        payload.status === "FAILED" ? current + 1 : current,
      );
      setSendProgressCurrentLabel(
        `${payload.recipientName || payload.email || `第 ${payload.rowNumber} 行`} ${payload.status === "SUCCESS" ? "已发送" : "发送失败"}`,
      );
    }).then((dispose) => {
      unlisten = dispose;
    });

    return () => {
      unlisten?.();
    };
  }, []);

  const sendProgressLabel = useMemo(() => {
    if (sendProgressTotal === 0) {
      return null;
    }
    if (isSending) {
      return `正在发送 ${sendProgressCount} / ${sendProgressTotal}，成功 ${sendProgressSuccessCount}，失败 ${sendProgressFailureCount}`;
    }
    if (sendProgressCount >= sendProgressTotal) {
      return `发送完成 ${sendProgressCount} / ${sendProgressTotal}，成功 ${sendProgressSuccessCount}，失败 ${sendProgressFailureCount}`;
    }
    return `发送中断 ${sendProgressCount} / ${sendProgressTotal}，成功 ${sendProgressSuccessCount}，失败 ${sendProgressFailureCount}`;
  }, [
    isSending,
    sendProgressCount,
    sendProgressFailureCount,
    sendProgressSuccessCount,
    sendProgressTotal,
  ]);

  const sendProgressPercent = useMemo(() => {
    if (sendProgressTotal === 0) {
      return 0;
    }
    if (sendProgressTotal > 0) {
      return Math.max(
        6,
        Math.min(100, Math.round((sendProgressCount / sendProgressTotal) * 100)),
      );
    }
    return isSending ? 8 : 0;
  }, [isSending, sendProgressCount, sendProgressTotal]);

  const readyRows = useMemo(
    () =>
      preview?.rows
        .filter((row) => row.status === "READY")
        .map((row) => ({
          rowNumber: row.rowNumber,
          recipientName: row.recipientName,
          email: row.email,
          values: row.values,
        })) ?? [],
    [preview],
  );

  const hasDuplicateEmails = (preview?.duplicateEmailMessages.length ?? 0) > 0;
  const smtpValidationErrors = useMemo(() => validateSmtpSettings(smtp), [smtp]);

  const failedRows = useMemo(() => {
    const invalidPreviewRows =
      preview?.rows
        .filter((row) => row.status === "INVALID")
        .map((row) => ({
          rowNumber: row.rowNumber,
          recipientName: row.recipientName,
          email: row.email,
          message: row.message,
          values: row.values,
        })) ?? [];

    const failedSendRows =
      sendResult?.results
        .filter((row) => row.status === "FAILED")
        .map((row) => ({
          rowNumber: row.rowNumber,
          recipientName: row.recipientName,
          email: row.email,
          message: row.message,
          values: row.values,
        })) ?? [];

    const merged = new Map<number, (typeof invalidPreviewRows)[number]>();
    [...invalidPreviewRows, ...failedSendRows].forEach((row) =>
      merged.set(row.rowNumber, row),
    );
    return Array.from(merged.values()).sort(
      (left, right) => left.rowNumber - right.rowNumber,
    );
  }, [preview, sendResult]);

  async function handlePreview(nextFile?: File | null) {
    const targetFile = nextFile ?? file;
    if (!targetFile) {
      setError("请先选择工资条文件");
      return;
    }
    setError(null);
    setSettingsMessage(null);
    setSendResult(null);
    setSendProgressCount(0);
    setSendProgressTotal(0);
    setSendProgressCurrentLabel(null);
    setSendProgressSuccessCount(0);
    setSendProgressFailureCount(0);
    setIsPreviewing(true);
    try {
      const result = await parsePayslipFile(targetFile);
      
      // 为每条工资条记录添加检查
      const checkedRows = result.rows.map(row => {
        // 检查是否有姓名和邮箱
        if (!row.recipientName || !row.email) {
          return {
            ...row,
            status: "INVALID",
            message: "缺少姓名或邮箱"
          };
        }
        
        // 检查是否已保存员工信息
        if (!employeeDataSaved || employeeData.length === 0) {
          return {
            ...row,
            status: "INVALID",
            message: "未导入员工信息"
          };
        }
        
        // 检查是否与员工信息匹配
        const isMatched = employeeData.some(employee => {
          // 忽略大小写和多余的空格进行比较
          const employeeName = employee.name?.trim().toLowerCase() || '';
          const employeeEmail = employee.email?.trim().toLowerCase() || '';
          const rowName = row.recipientName?.trim().toLowerCase() || '';
          const rowEmail = row.email?.trim().toLowerCase() || '';
          return employeeName === rowName && employeeEmail === rowEmail;
        });
        
        // 如果不匹配，修改状态和消息
        if (!isMatched) {
          return {
            ...row,
            status: "INVALID",
            message: "姓名或邮箱不匹配"
          };
        }
        
        // 所有检查都通过，保持原始状态
        return row;
      });
      
      // 更新预览结果
      setPreview({
        ...result,
        rows: checkedRows,
        readyCount: checkedRows.filter(row => row.status === "READY").length,
        invalidCount: checkedRows.filter(row => row.status === "INVALID").length
      });
      
      if (
        subjectTemplate === DEFAULT_SUBJECT_TEMPLATE &&
        defaultSubjectTemplate === DEFAULT_SUBJECT_TEMPLATE
      ) {
        setSubjectTemplate(result.defaultSubjectTemplate);
      }
      if (
        bodyTemplate === buildDefaultBodyTemplate() &&
        defaultBodyTemplate === buildDefaultBodyTemplate()
      ) {
        setBodyTemplate(result.defaultBodyTemplate);
      }
    } catch (invokeError) {
      setPreview(null);
      setError(
        invokeError instanceof Error ? invokeError.message : "工资条预览失败",
      );
    } finally {
      setIsPreviewing(false);
    }
  }

  async function handleSend() {
    if (readyRows.length === 0) {
      setError("当前没有可发送的工资条记录");
      return;
    }

    const validationErrors = validateSmtpSettings(smtp);
    if (Object.keys(validationErrors).length > 0) {
      setError(
        `请先完善 SMTP 配置：${Object.values(validationErrors)
          .map((message) => message.replace(/^请输入/, ""))
          .join("、")}`,
      );
      return;
    }

    setError(null);
    setSettingsMessage(null);
    setIsSending(true);
    setSendProgressCount(0);
    setSendProgressTotal(readyRows.length);
    setSendProgressCurrentLabel("正在准备发送");
    setSendProgressSuccessCount(0);
    setSendProgressFailureCount(0);
    try {
      await waitForNextPaint();
      const request: SendRequest = {
        subjectTemplate,
        bodyTemplate,
        smtp,
        rows: readyRows,
      };
      const result = await sendPayslips(request);
      setSendProgressCount(result.totalCount);
      setSendProgressTotal(result.totalCount);
      setSendProgressSuccessCount(result.successCount);
      setSendProgressFailureCount(result.failureCount);
      setSendProgressCurrentLabel(
        result.failureCount > 0 ? "发送完成，部分记录失败" : "发送完成",
      );
      setSendResult(result);
    } catch (invokeError) {
      setError(
        invokeError instanceof Error ? invokeError.message : "工资条发送失败",
      );
    } finally {
      setIsSending(false);
    }
  }

  async function handleSaveSettings(nextSettings?: PayslipSettings) {
    const settings = nextSettings ?? {
      defaultSubjectTemplate,
      defaultBodyTemplate,
      smtp,
    };
    const validationErrors = validateSmtpSettings(settings.smtp);
    if (Object.keys(validationErrors).length > 0) {
      setError(
        `请先完善 SMTP 配置：${Object.values(validationErrors)
          .map((message) => message.replace(/^请输入/, ""))
          .join("、")}`,
      );
      setSettingsMessage(null);
      return;
    }
    setIsSavingSettings(true);
    setError(null);
    setSettingsMessage(null);
    try {
      await saveSettings(settings);
      setSettingsMessage("配置已保存，下次打开应用会自动读取。");
    } catch (invokeError) {
      setError(
        invokeError instanceof Error
          ? invokeError.message
          : "保存工资条配置失败",
      );
    } finally {
      setIsSavingSettings(false);
    }
  }

  function handleRestoreDefaults() {
    setSubjectTemplate(defaultSubjectTemplate);
    setBodyTemplate(defaultBodyTemplate);
  }

  function handleRestoreDefaultSmtp() {
    setSmtp(defaultSmtp);
  }

  function handleResetImportedFile() {
    setFile(null);
    setPreview(null);
    setSendResult(null);
    setError(null);
    setSettingsMessage(null);
    setSendProgressCount(0);
    setSendProgressTotal(0);
    setSendProgressCurrentLabel(null);
    setSendProgressSuccessCount(0);
    setSendProgressFailureCount(0);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function handleSyncCurrentAsDefault() {
    const nextSettings = {
      defaultSubjectTemplate: subjectTemplate,
      defaultBodyTemplate: bodyTemplate,
      smtp,
    };
    setDefaultSubjectTemplate(subjectTemplate);
    setDefaultBodyTemplate(bodyTemplate);
    void handleSaveSettings(nextSettings);
  }

  function handleSyncCurrentSmtpAsDefault() {
    const nextSettings = {
      defaultSubjectTemplate,
      defaultBodyTemplate,
      smtp,
    };
    setDefaultSmtp(smtp);
    void handleSaveSettings(nextSettings);
  }

  async function handleEmployeeFileImport(event: React.ChangeEvent<HTMLInputElement>) {
    const nextFile = event.target.files?.[0] ?? null;
    if (!nextFile) {
      return;
    }
    setEmployeeFile(nextFile);
    // 清除之前的错误提示
    setError('');
    // 设置加载状态
    setIsEmployeeFileLoading(true);
    try {
      // 实际的文件解析逻辑
      const reader = new FileReader();
      
      reader.onload = (e) => {
        try {
          const content = e.target?.result as string;
          let parsedData: any[] = [];
          
          // 根据文件类型进行解析
          if (nextFile.name.endsWith('.csv')) {
            // CSV 文件解析
            const lines = content.split('\n').filter(line => line.trim() !== '');
            if (lines.length > 0) {
              const headers = lines[0].split(',').map(header => header.trim());
              for (let i = 1; i < lines.length; i++) {
                const values = lines[i].split(',').map(value => value.trim());
                const row: any = {};
                headers.forEach((header, index) => {
                  row[header] = values[index] || '';
                });
                parsedData.push(row);
              }
            }
          } else if (nextFile.name.endsWith('.xlsx') || nextFile.name.endsWith('.xls')) {
            // Excel 文件解析
            const arrayBuffer = e.target?.result as ArrayBuffer;
            const workbook = XLSX.read(arrayBuffer, { type: 'array' });
            const firstSheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[firstSheetName];
            const jsonData = XLSX.utils.sheet_to_json(worksheet);
            parsedData = jsonData;
          }
          
          // 收集所有字段名
          const allFields = new Set<string>();
          parsedData.forEach(row => {
            Object.keys(row).forEach(key => {
              allFields.add(key);
            });
          });
          
          // 数据验证逻辑
          const validatedData = parsedData.map((employee, index) => {
            const errors = [];
            
            // 检查是否有姓名列
            if (!employee.name && !employee['姓名']) {
              errors.push('缺少姓名');
            }
            
            // 检查是否有邮箱列
            if (!employee.email && !employee['邮箱']) {
              errors.push('缺少邮箱');
            }
            
            // 检查邮箱唯一性
            const email = employee.email || employee['邮箱'];
            if (email) {
              const emailCount = parsedData.filter(e => (e.email || e['邮箱']) === email).length;
              if (emailCount > 1) {
                errors.push('邮箱重复，请检查');
              }
            }
            
            // 保留原始数据，添加验证信息，并统一姓名和邮箱字段
            return {
              ...employee,
              name: employee.name || employee['姓名'] || '',
              email: employee.email || employee['邮箱'] || '',
              id: index + 1,
              error: errors.length > 0 ? errors.join('; ') : ''
            };
          });
          
          // 保存所有字段名，用于渲染表头
          setAllEmployeeFields(Array.from(allFields));
          setEmployeeData(validatedData);
          setEmployeeDataSaved(false); // 重置保存状态
        } catch (error) {
          setError('员工文件解析失败');
        } finally {
          // 无论成功失败，都设置加载状态为 false
          setIsEmployeeFileLoading(false);
        }
      };
      
      reader.onerror = () => {
        setError('员工文件读取失败');
        // 设置加载状态为 false
        setIsEmployeeFileLoading(false);
      };
      
      // 读取文件内容
      if (nextFile.name.endsWith('.csv')) {
        // 读取 CSV 文件时指定编码为 UTF-8，确保中文正确处理
        reader.readAsText(nextFile, 'UTF-8');
      } else if (nextFile.name.endsWith('.xlsx') || nextFile.name.endsWith('.xls')) {
        reader.readAsArrayBuffer(nextFile);
      }
    } catch (error) {
      setError('员工文件解析失败');
      // 设置加载状态为 false
      setIsEmployeeFileLoading(false);
    }
  }

  function handleSaveEmployeeData() {
    // 检查是否有错误数据
    const hasErrorData = employeeData.some(employee => employee.error);
    
    if (hasErrorData) {
      // 有错误数据，不允许保存
      setError('有非法数据，请处理后再重新导入保存');
      // 错误提示一直显示，直到用户重新导入文件或清空数据
    } else {
      // 没有错误数据，允许保存
      // 这里可以添加实际的保存逻辑
      setEmployeeDataSaved(true);
      // 显示保存成功提示
      setError('保存成功');
      // 3秒后清除提示
      setTimeout(() => {
        setError('');
      }, 3000);
    }
  }

  function handleClearEmployeeData() {
    setEmployeeFile(null);
    setEmployeeData([]);
    setEmployeeDataSaved(false);
    setError(''); // 清除错误提示
    if (employeeFileInputRef.current) {
      employeeFileInputRef.current.value = '';
    }
  }

  function renderEmployeePage() {
    return (
      <main className="app-shell">
        <section className="panel-card">
          <div className="panel-title">
            <div>
              <button
                className="ghost-button"
                type="button"
                onClick={() => {
                  // 清除错误提示
                  setError('');
                  // 只有在数据未保存的情况下才清空数据
                  if (!employeeDataSaved) {
                    setEmployeeFile(null);
                    setEmployeeData([]);
                    if (employeeFileInputRef.current) {
                      employeeFileInputRef.current.value = '';
                    }
                  }
                  setCurrentPage('main');
                }}
              >
                ← 返回
              </button>
              <h2 style={{ marginLeft: '12px', display: 'inline-block' }}>员工信息详情</h2>
            </div>
          </div>
          <div className="panel-body">
            <div className="file-upload-container" style={{ marginBottom: '12px' }}>
              <input
                ref={employeeFileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleEmployeeFileImport}
              />
              <div className="file-upload-overlay">
                <p className="file-upload-text">请选择文件上传</p>
                <p className="file-upload-hint">支持 .xlsx, .xls, .csv 格式</p>
              </div>
            </div>
            {employeeFile && (
              <p className="feedback success-text">已选择文件：{employeeFile.name}</p>
            )}
            <div className="action-row">
              <button
                className="secondary-button"
                type="button"
                disabled={employeeData.length === 0 || isEmployeeFileLoading}
                onClick={handleSaveEmployeeData}
              >
                {isEmployeeFileLoading ? '加载中...' : '保存数据'}
              </button>
              <button
                className="danger-button"
                type="button"
                disabled={employeeData.length === 0 || isEmployeeFileLoading}
                onClick={handleClearEmployeeData}
              >
                清空数据
              </button>
            </div>

            {error && (
              <p className="feedback error-text">{error}</p>
            )}

            {employeeData.length > 0 ? (
              <div className="table-shell">
                <table>
                  <thead>
                    <tr>
                      <th>序号</th>
                      {/* 动态生成表头，排除用户导入的"状态"列 */}
                      {allEmployeeFields.filter(key => key !== 'id' && key !== 'error' && key !== '状态' && key !== 'status').map((header) => (
                        <th key={header}>{header}</th>
                      ))}
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {employeeData.map((employee) => (
                      <tr key={employee.id} className={employee.error ? 'error-row' : ''}>
                        <td>{employee.id}</td>
                        {/* 动态生成表格行，排除用户导入的"状态"列 */}
                        {allEmployeeFields.filter(key => key !== 'id' && key !== 'error' && key !== '状态' && key !== 'status').map((key) => {
                          // 显示原始值，不显示错误信息
                          return <td key={key}>{employee[key] || '-'}</td>;
                        })}
                        <td className={employee.error ? 'error-text' : ''}>
                          {employee.error || '正常'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="placeholder-text">
                支持 .xlsx、.xls、.csv 格式文件，数据需包含「姓名」「邮箱」字段。
              </p>
            )}
          </div>
        </section>
      </main>
    );
  }

  return (
    <>
      {currentPage === 'main' ? (
        <main className="app-shell">
          <section className="hero-card">
            <div className="hero-copy">
              <p className="eyebrow">BeeWorks Desktop Tool</p>
              <h1>工资条管理</h1>
              <p className="hero-text">
                应用使用流程：<br/>
                1. 设置SMTP配置：在应用的"SMTP 配置"部分，填写正确的SMTP服务器信息，包括主机、端口、用户名、密码和发件邮箱。<br/>
                2. 维护员工信息：点击"员工信息"按钮，导入包含"姓名"和"邮箱"的文件，确保邮箱是唯一的，然后保存员工信息。<br/>
                3. 导入工资条文件：在主页面上传工资条文件，系统会自动验证文件中的"姓名"和"邮箱"是否与员工信息匹配，只有匹配的记录才能发送。
              </p>
            </div>
            <div className="hero-metrics">
              <div className="metric">
                <span>待发送</span>
                <strong>{readyRows.length}</strong>
              </div>
              <div className="metric">
                <span>校验失败</span>
                <strong>{preview?.invalidCount ?? 0}</strong>
              </div>
              <div className="metric">
                <span>发送成功</span>
                <strong>{sendResult?.successCount ?? 0}</strong>
              </div>
            </div>
          </section>

          <section className="panel-card">
            <div className="panel-title">
              <div>
                <h2>上传工资条信息</h2>
              </div>
              <div>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => setCurrentPage('employee')}
                >
                  👥 员工信息
                </button>
              </div>
            </div>
            <div className="panel-body">
              <label className="field field-wide">
                <span>工资条文件</span>
                <div className="file-upload-container">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={(event) => {
                      const nextFile = event.target.files?.[0] ?? null;
                      setFile(nextFile);
                      void handlePreview(nextFile);
                    }}
                  />
                  <div className="file-upload-overlay">
                    <p className="file-upload-text">请选择文件上传</p>
                    <p className="file-upload-hint">支持 .xlsx, .xls, .csv 格式</p>
                  </div>
                </div>
              </label>

              <div className="action-row">
                <button
                  className="primary-button"
                  type="button"
                  onClick={handleSend}
                  disabled={isSending || readyRows.length === 0 || hasDuplicateEmails}
                >
                  {isSending ? "发送中..." : `发送 ${readyRows.length} 条`}
                </button>
                <button
                  className="danger-button"
                  type="button"
                  disabled={!preview || failedRows.length === 0}
                  onClick={() => preview && exportFailedRows(preview, failedRows)}
                >
                  {`导出预览/发送失败记录 ${failedRows.length} 条`}
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  disabled={!file && !preview && !sendResult}
                  onClick={handleResetImportedFile}
                >
                  清空当前文件
                </button>
              </div>

              {sendProgressTotal > 0 ? (
                <div className="progress-card" aria-live="polite">
                  <div className="progress-copy">
                    <strong>{isSending ? "发送进行中" : "发送进度"}</strong>
                    <span>{sendProgressLabel}</span>
                  </div>
                  <div className="progress-track">
                    <div
                      className="progress-fill"
                        style={{ width: `${sendProgressPercent}%` }}
                      />
                    </div>
                    <p className="helper-text">
                    {sendProgressCurrentLabel ?? "真实 SMTP 发送会逐条反馈处理进度。"}
                  </p>
                </div>
              ) : null}

              {error ? <p className="feedback error-text">{error}</p> : null}
              {hasDuplicateEmails ? (
                <div className="duplicate-alert" role="alert">
                  <p className="feedback error-text">
                    检测到重复邮箱，已禁止本次发送。请先修正导入文件后重新预览：
                  </p>
                  <ul className="duplicate-list">
                    {preview?.duplicateEmailMessages.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {settingsMessage ? (
                <p className="feedback success-text">{settingsMessage}</p>
              ) : null}

              {preview ? (
                <>
                  <div className="summary-grid">
                    <div className="summary-pill">文件：{preview.fileName}</div>
                    <div className="summary-pill">工作表：{preview.sheetName}</div>
                    <div className="summary-pill">总记录：{preview.totalCount}</div>
                    <div className="summary-pill">可发送：{preview.readyCount}</div>
                    <div className="summary-pill">
                      校验失败：{preview.invalidCount}
                    </div>
                    <div className="summary-pill">
                      已跳过：{preview.skippedCount}
                    </div>
                  </div>

                  <div className="table-shell">
                    <table>
                      <thead>
                        <tr>
                          <th>序号</th>
                          <th>人员</th>
                          <th>邮箱</th>
                          <th>月份</th>
                          <th>实发工资</th>
                          <th>状态</th>
                          <th>说明</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.rows.map((row, index) => (
                          <tr
                            key={`${row.rowNumber}-${row.email}-${row.recipientName}`}
                          >
                            <td>{index + 1}</td>
                            <td>{row.recipientName || "-"}</td>
                            <td>{row.email || "-"}</td>
                            <td>{row.month || "-"}</td>
                            <td>{row.netPay || row.values["工资总额"] || "-"}</td>
                            <td>
                              <span
                                className={`status-badge status-${row.status.toLowerCase()}`}
                              >
                                {PREVIEW_STATUS_TEXT[row.status]}
                              </span>
                            </td>
                            <td>{row.message}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <p className="placeholder-text">
                  选择工资条文件后先执行预览校验，桌面端会本地解析 Excel/CSV
                  并标记可发送记录。
                </p>
              )}
            </div>
          </section>

          {sendResult ? (
            <section className="panel-card">
              <div className="panel-title">
                <div>
                  <h2>发送结果</h2>
                </div>
              </div>
              <div className="panel-body">
                <div className="summary-grid">
                  <div className="summary-pill">总数：{sendResult.totalCount}</div>
                  <div className="summary-pill">
                    成功：{sendResult.successCount}
                  </div>
                  <div className="summary-pill">
                    失败：{sendResult.failureCount}
                  </div>
                </div>
                <div className="table-shell">
                  <table>
                    <thead>
                      <tr>
                        <th>行号</th>
                        <th>人员</th>
                        <th>邮箱</th>
                        <th>状态</th>
                        <th>说明</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sendResult.results.map((row) => (
                        <tr key={`${row.rowNumber}-${row.email}-${row.status}`}>
                          <td>{row.rowNumber}</td>
                          <td>{row.recipientName}</td>
                          <td>{row.email}</td>
                          <td>
                            <span
                              className={`status-badge status-${row.status === "SUCCESS" ? "ready" : "invalid"}`}
                            >
                              {SEND_STATUS_TEXT[row.status]}
                            </span>
                          </td>
                          <td>{row.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          ) : null}

          <section className="workspace-grid">
            <article className="panel-card">
              <div className="panel-title">
                <div>
                  <h2>邮件模板</h2>
                </div>
              </div>
              <div className="panel-body">
                <label className="field">
                  <span>邮件主题模板</span>
                  <input
                    value={subjectTemplate}
                    onChange={(event) => setSubjectTemplate(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>邮件正文模板</span>
                  <textarea
                    rows={12}
                    value={bodyTemplate}
                    onChange={(event) => setBodyTemplate(event.target.value)}
                  />
                </label>
                <p className="helper-text">
                  可直接使用表头变量，例如 `{"{{人员}}"}`、`{"{{月份}}"}`、`
                  {"{{实发工资}}"}`、`{"{{邮箱}}"}`。
                </p>
                <div className="action-row">
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={handleRestoreDefaults}
                  >
                    恢复默认
                  </button>
                  <button
                    className="ghost-button"
                    type="button"
                    disabled={isSavingSettings}
                    onClick={handleSyncCurrentAsDefault}
                  >
                    {isSavingSettings ? "保存中..." : "设为默认"}
                  </button>
                </div>
              </div>
            </article>

            <article className="panel-card">
              <div className="panel-title">
                <div>
                  <h2>SMTP 配置</h2>
                </div>
              </div>
              <div className="panel-body">
                <div className="form-grid">
                  <label className="field">
                    <span>SMTP 主机</span>
                    <input
                      aria-invalid={Boolean(smtpValidationErrors.host)}
                      className={smtpValidationErrors.host ? "input-error" : undefined}
                      value={smtp.host}
                      onChange={(event) =>
                        setSmtp((current) => ({
                          ...current,
                          host: event.target.value,
                        }))
                      }
                    />
                    {smtpValidationErrors.host ? (
                      <span className="field-error">{smtpValidationErrors.host}</span>
                    ) : null}
                  </label>
                  <label className="field">
                    <span>端口</span>
                    <input
                      aria-invalid={Boolean(smtpValidationErrors.port)}
                      className={smtpValidationErrors.port ? "input-error" : undefined}
                      value={smtp.port}
                      onChange={(event) =>
                        setSmtp((current) => ({
                          ...current,
                          port: event.target.value,
                        }))
                      }
                    />
                    {smtpValidationErrors.port ? (
                      <span className="field-error">{smtpValidationErrors.port}</span>
                    ) : null}
                  </label>
                  <label className="field">
                    <span>用户名</span>
                    <input
                      aria-invalid={Boolean(smtpValidationErrors.username)}
                      className={smtpValidationErrors.username ? "input-error" : undefined}
                      value={smtp.username}
                      onChange={(event) =>
                        setSmtp((current) => ({
                          ...current,
                          username: event.target.value,
                        }))
                      }
                    />
                    {smtpValidationErrors.username ? (
                      <span className="field-error">{smtpValidationErrors.username}</span>
                    ) : null}
                  </label>
                  <label className="field">
                    <span>密码 / 授权码</span>
                    <input
                      type="password"
                      aria-invalid={Boolean(smtpValidationErrors.password)}
                      className={smtpValidationErrors.password ? "input-error" : undefined}
                      value={smtp.password}
                      onChange={(event) =>
                        setSmtp((current) => ({
                          ...current,
                          password: event.target.value,
                        }))
                      }
                    />
                    {smtpValidationErrors.password ? (
                      <span className="field-error">{smtpValidationErrors.password}</span>
                    ) : null}
                  </label>
                  <label className="field">
                    <span>发件邮箱</span>
                    <input
                      aria-invalid={Boolean(smtpValidationErrors.fromAddress)}
                      className={smtpValidationErrors.fromAddress ? "input-error" : undefined}
                      value={smtp.fromAddress}
                      onChange={(event) =>
                        setSmtp((current) => ({
                          ...current,
                          fromAddress: event.target.value,
                        }))
                      }
                    />
                    {smtpValidationErrors.fromAddress ? (
                      <span className="field-error">{smtpValidationErrors.fromAddress}</span>
                    ) : null}
                  </label>
                  <label className="field">
                    <span>发件人名称</span>
                    <input
                      value={smtp.fromName}
                      onChange={(event) =>
                        setSmtp((current) => ({
                          ...current,
                          fromName: event.target.value,
                        }))
                      }
                    />
                  </label>
                </div>

                <div className="toggle-row">
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={smtp.auth}
                      onChange={(event) =>
                        setSmtp((current) => ({
                          ...current,
                          auth: event.target.checked,
                        }))
                      }
                    />
                    <span>启用 SMTP 认证</span>
                  </label>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={smtp.starttls}
                      onChange={(event) =>
                        setSmtp((current) => ({
                          ...current,
                          starttls: event.target.checked,
                        }))
                      }
                    />
                    <span>启用 STARTTLS</span>
                  </label>
                </div>

                <div className="action-row">
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={handleRestoreDefaultSmtp}
                  >
                    恢复默认
                  </button>
                  <button
                    className="ghost-button"
                    type="button"
                    disabled={isSavingSettings}
                    onClick={handleSyncCurrentSmtpAsDefault}
                  >
                    {isSavingSettings ? "保存中..." : "设为默认"}
                  </button>
                </div>
              </div>
            </article>
          </section>
        </main>
      ) : (
        renderEmployeePage()
      )}
    </>
  );
}

export default App;
