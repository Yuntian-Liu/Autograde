import { Modal, Tabs } from "antd";
import { PRIVACY_POLICY_HTML, USER_AGREEMENT_HTML } from "../legal/agreement";

// 用户协议 / 隐私政策 弹窗：注册勾选与设置页共用
export default function AgreementModal({ open, onClose, initialTab = "agreement" }) {
  return (
    <Modal
      centered
      open={open}
      onCancel={onClose}
      footer={null}
      width={560}
      destroyOnHidden
    >
      <Tabs
        defaultActiveKey={initialTab}
        items={[
          { key: "agreement", label: "用户协议", children: <LegalBody html={USER_AGREEMENT_HTML} /> },
          { key: "privacy", label: "隐私政策", children: <LegalBody html={PRIVACY_POLICY_HTML} /> },
        ]}
      />
    </Modal>
  );
}

function LegalBody({ html }) {
  return (
    <div className="legal-body">
      {/* 内容为本仓库静态常量，非外部输入 */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
